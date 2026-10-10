import type { Priority } from '../riot/client';
import { regionalFor, type RegionalRoute } from '../riot/regions';
import { parseRiotId, type IngestDeps } from '../tft/ingest';
import { buildLolProfile } from './aggregate';
import { LolStore, seasonOf } from './store';
import type { LolProfile } from './types';

// League of Legends ingestion: ranked Solo/Duo + Flex games for the current season (calendar year).
// Same shape as TFT: catch up on new games now, backfill the rest of the season in the background.

const RECENT_PAGE = 20;
const RECENT_MAX_PAGES = 5;
const HISTORY_PAGE = 100; // Riot's max for match-v5 ids
const DETAIL_CHUNK = 20;
const OLD_STREAK_TO_STOP = 5; // consecutive games from before this season

export interface LolIngestResult {
  puuid: string;
  profile: LolProfile;
  fetchedMatchIds: string[];
  history: Promise<void>;
}

const lol = (deps: IngestDeps) => new LolStore(deps.store.db);
const currentSeason = (deps: IngestDeps) => seasonOf((deps.now ?? Date.now)());

async function fetchUncached(
  deps: IngestDeps,
  regional: RegionalRoute,
  ids: string[],
  priority: Priority = 'foreground',
): Promise<string[]> {
  const store = lol(deps);
  const missing = ids.filter((id) => !store.hasMatch(id));
  const fetched = await Promise.all(missing.map((id) => deps.client.getLolMatch(regional, id, priority)));
  for (const raw of fetched) store.saveMatch(raw);
  return missing;
}

async function syncRecent(deps: IngestDeps, regional: RegionalRoute, puuid: string) {
  const store = lol(deps);
  const syncPoint = store.syncPoint(puuid);
  const fetchedMatchIds: string[] = [];
  let newestIds: string[] = [];
  let caughtUp = false;
  for (let page = 0; page < RECENT_MAX_PAGES && !caughtUp; page++) {
    const ids = await deps.client.getLolMatchIds(regional, puuid, { start: page * RECENT_PAGE, count: RECENT_PAGE });
    if (page === 0) newestIds = ids;
    fetchedMatchIds.push(...(await fetchUncached(deps, regional, ids)));
    const oldest = store.oldestGameEnd(ids);
    caughtUp = syncPoint !== null && (ids.length < RECENT_PAGE || oldest === null || oldest <= syncPoint);
    if (syncPoint === null) break;
  }
  return { fetchedMatchIds, caughtUp, lastMatchAt: store.newestGameEnd(newestIds) };
}

const backfills = new Map<string, Promise<void>>();

export function backfillLol(deps: IngestDeps, regional: RegionalRoute, puuid: string): Promise<void> {
  const running = backfills.get(puuid);
  if (running) return running;
  const run = (async () => {
    const store = lol(deps);
    const season = currentSeason(deps);
    let oldStreak = 0;
    for (let start = 0; ; start += HISTORY_PAGE) {
      const ids = await deps.client.getLolMatchIds(regional, puuid, { start, count: HISTORY_PAGE, priority: 'background' });
      for (let i = 0; i < ids.length && oldStreak < OLD_STREAK_TO_STOP; i += DETAIL_CHUNK) {
        const chunk = ids.slice(i, i + DETAIL_CHUNK);
        await fetchUncached(deps, regional, chunk, 'background');
        for (const id of chunk) {
          const s = store.matchSeason(id);
          oldStreak = s !== null && s < season ? oldStreak + 1 : 0;
          if (oldStreak >= OLD_STREAK_TO_STOP) break;
        }
      }
      if (oldStreak >= OLD_STREAK_TO_STOP || ids.length < HISTORY_PAGE) break;
    }
    store.markHistoryComplete(puuid, season);
  })().finally(() => backfills.delete(puuid));
  backfills.set(puuid, run);
  return run;
}

/** The LoL profile from what's cached. No Riot calls. */
export function loadLolProfile(deps: IngestDeps, puuid: string, riotId: string, region: string): LolProfile {
  const store = lol(deps);
  const season = currentSeason(deps);
  return buildLolProfile({
    riotId,
    region,
    season,
    rows: store.getParticipations(puuid, season),
    ranks: store.latestRanks(puuid),
    history: { complete: store.historyComplete(puuid, season), syncing: backfills.has(puuid) },
  });
}

export function hasLolData(deps: IngestDeps, puuid: string): boolean {
  return lol(deps).hasPlayer(puuid);
}

/** One player's LoL ingestion run: account -> new ranked games + ranks (in parallel) -> profile. */
export async function ingestLol(deps: IngestDeps, platform: string, riotId: string): Promise<LolIngestResult> {
  const region = platform.toLowerCase();
  const regional = regionalFor(region);
  const { gameName, tagLine } = parseRiotId(riotId);
  const account = await deps.client.getAccountByRiotId(regional, gameName, tagLine);
  const puuid = account.puuid;

  const [recent, entries] = await Promise.all([
    syncRecent(deps, regional, puuid),
    deps.client.getLolLeagueEntries(region, puuid),
  ]);

  // The players row is shared with TFT; it must exist before lol_sync (foreign key).
  deps.store.upsertPlayer({ puuid, gameName: account.gameName, tagLine: account.tagLine, region, lastMatchAt: null });
  const store = lol(deps);
  store.setSyncPoint(puuid, recent.lastMatchAt);
  store.saveRanks(puuid, entries, (deps.now ?? Date.now)());

  let history: Promise<void> = Promise.resolve();
  if (!recent.caughtUp || !store.historyComplete(puuid, currentSeason(deps))) {
    history = backfillLol(deps, regional, puuid);
    history.catch((err) => console.error(`LoL history backfill failed for ${riotId}:`, err));
  }

  const profile = loadLolProfile(deps, puuid, `${account.gameName}#${account.tagLine}`, region);
  return { puuid, profile, fetchedMatchIds: recent.fetchedMatchIds, history };
}

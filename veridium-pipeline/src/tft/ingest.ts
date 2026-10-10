import type { Store } from '../cache/store';
import type { Priority, RiotClient } from '../riot/client';
import { regionalFor, type RegionalRoute } from '../riot/regions';
import type { PlayerProfile } from '../types';
import { buildProfile, trackedSets } from './aggregate';
import { toMatchups, toRankSnapshot } from './transform';

export interface IngestDeps {
  client: RiotClient;
  store: Store;
  seasons: number; // current set + (seasons - 1) previous
  now?: () => number;
}

export interface IngestResult {
  puuid: string;
  profile: PlayerProfile;
  fetchedMatchIds: string[];
  /** Resolves when the player's season history is fully cached (immediately if it already was). */
  history: Promise<void>;
}

const RECENT_PAGE = 20; // ids per page when catching up on new games
const RECENT_MAX_PAGES = 5; // beyond this, the background backfill picks up the rest
const HISTORY_PAGE = 100; // ids per page when backfilling
const DETAIL_CHUNK = 20; // match details fetched per step while backfilling
const OLD_STREAK_TO_STOP = 10; // consecutive pre-season matches before backfill stops (revival events can be old sets)

/** "Name#TAG" (or "Name-TAG", handy in URLs) -> parts. */
export function parseRiotId(riotId: string): { gameName: string; tagLine: string } {
  const sep = riotId.includes('#') ? riotId.lastIndexOf('#') : riotId.lastIndexOf('-');
  if (sep <= 0 || sep === riotId.length - 1) throw new Error(`Invalid Riot ID "${riotId}", expected Name#TAG`);
  return { gameName: riotId.slice(0, sep), tagLine: riotId.slice(sep + 1) };
}

async function fetchUncached(
  deps: IngestDeps,
  regional: RegionalRoute,
  ids: string[],
  priority: Priority = 'foreground',
): Promise<string[]> {
  const missing = ids.filter((id) => !deps.store.hasMatch(id));
  const fetched = await Promise.all(missing.map((id) => deps.client.getMatch(regional, id, priority)));
  for (const raw of fetched) deps.store.saveMatch(raw, toMatchups(raw));
  return missing;
}

/** Fetch games newer than the player's sync point. A never-seen player gets one page now, the rest via backfill. */
async function syncRecent(deps: IngestDeps, regional: RegionalRoute, puuid: string) {
  const syncPoint = deps.store.playerSyncPoint(puuid);
  const fetchedMatchIds: string[] = [];
  let newestIds: string[] = [];
  let caughtUp = false;
  for (let page = 0; page < RECENT_MAX_PAGES && !caughtUp; page++) {
    const ids = await deps.client.getMatchIds(regional, puuid, { start: page * RECENT_PAGE, count: RECENT_PAGE });
    if (page === 0) newestIds = ids;
    fetchedMatchIds.push(...(await fetchUncached(deps, regional, ids)));
    const oldest = deps.store.oldestMatchTime(ids);
    caughtUp = syncPoint !== null && (ids.length < RECENT_PAGE || oldest === null || oldest <= syncPoint);
    if (syncPoint === null) break;
  }
  return { fetchedMatchIds, caughtUp, lastMatchAt: deps.store.newestMatchTime(newestIds) };
}

function minTrackedSet(deps: IngestDeps): number | null {
  return trackedSets(deps.store.latestSet(), deps.seasons).at(-1) ?? null;
}

const backfills = new Map<string, Promise<void>>();

export function isBackfilling(puuid: string): boolean {
  return backfills.has(puuid);
}

/**
 * Walk the player's match list from newest to oldest, caching every match, until it's
 * past the oldest tracked set or Riot has nothing older. Cached ids cost no detail call,
 * so restarting from the top after an interruption is cheap. One run per player at a time.
 */
export function backfillHistory(deps: IngestDeps, regional: RegionalRoute, puuid: string): Promise<void> {
  const running = backfills.get(puuid);
  if (running) return running;

  const run = (async () => {
    const minSet = minTrackedSet(deps);
    if (minSet === null) return;
    let oldStreak = 0;
    for (let start = 0; ; start += HISTORY_PAGE) {
      const ids = await deps.client.getMatchIds(regional, puuid, { start, count: HISTORY_PAGE, priority: 'background' });
      for (let i = 0; i < ids.length && oldStreak < OLD_STREAK_TO_STOP; i += DETAIL_CHUNK) {
        const chunk = ids.slice(i, i + DETAIL_CHUNK);
        await fetchUncached(deps, regional, chunk, 'background');
        for (const id of chunk) {
          const set = deps.store.matchSet(id);
          oldStreak = set !== null && set < minSet ? oldStreak + 1 : 0;
          if (oldStreak >= OLD_STREAK_TO_STOP) break;
        }
      }
      if (oldStreak >= OLD_STREAK_TO_STOP || ids.length < HISTORY_PAGE) break;
    }
    deps.store.markHistoryComplete(puuid, minSet);
  })().finally(() => backfills.delete(puuid));

  backfills.set(puuid, run);
  return run;
}

/** Build the profile from what's cached. No Riot calls. */
export function loadProfile(deps: IngestDeps, puuid: string, riotId: string, region: string): PlayerProfile {
  const { store } = deps;
  const currentSet = store.latestSet();
  const sets = trackedSets(currentSet, deps.seasons);
  const minSet = sets.at(-1) ?? null;
  return buildProfile({
    riotId,
    region,
    matchups: minSet === null ? [] : store.getMatchups(puuid, minSet),
    snapshots: store.getRankSnapshots(puuid),
    currentSet,
    sets,
    history: {
      complete: minSet !== null && store.historyComplete(puuid, minSet),
      syncing: isBackfilling(puuid),
    },
  });
}

/**
 * One player's ingestion run:
 * resolve PUUID -> new matches + rank entry (in parallel) -> fetch only uncached matches -> aggregate.
 * If the tracked seasons aren't fully cached yet, a backfill keeps running after this returns.
 */
export async function ingestPlayer(deps: IngestDeps, platform: string, riotId: string): Promise<IngestResult> {
  const { client, store } = deps;
  const now = deps.now ?? Date.now;
  const region = platform.toLowerCase();
  const regional = regionalFor(region);
  const { gameName, tagLine } = parseRiotId(riotId);

  // 1. Riot ID -> PUUID
  const account = await client.getAccountByRiotId(regional, gameName, tagLine);
  const puuid = account.puuid;

  // 2-3. New matches (cache-checked per id), in parallel with 4. the rank entry, always fresh.
  const [recent, leagueEntries] = await Promise.all([
    syncRecent(deps, regional, puuid),
    client.getLeagueEntries(region, puuid),
  ]);

  store.upsertPlayer({
    puuid,
    gameName: account.gameName,
    tagLine: account.tagLine,
    region,
    lastMatchAt: recent.lastMatchAt,
  });
  const snapshot = toRankSnapshot(leagueEntries, now());
  if (snapshot) store.saveRankSnapshot(puuid, snapshot);

  // Full season history, in the background the first time (or after a gap too long for syncRecent).
  const minSet = minTrackedSet(deps);
  let history: Promise<void> = Promise.resolve();
  if (minSet !== null && (!recent.caughtUp || !store.historyComplete(puuid, minSet))) {
    history = backfillHistory(deps, regional, puuid);
    history.catch((err) => console.error(`History backfill failed for ${riotId}:`, err));
  }

  // 5. Aggregate
  const profile = loadProfile(deps, puuid, `${account.gameName}#${account.tagLine}`, region);
  return { puuid, profile, fetchedMatchIds: recent.fetchedMatchIds, history };
}

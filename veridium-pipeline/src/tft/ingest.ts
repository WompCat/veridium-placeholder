import type { Store } from '../cache/store';
import type { RiotClient } from '../riot/client';
import { regionalFor } from '../riot/regions';
import type { PlayerProfile, TftMatchDto } from '../types';
import { buildProfile } from './aggregate';
import { toMatchups, toRankSnapshot } from './transform';

export interface IngestDeps {
  client: RiotClient;
  store: Store;
  matchWindow: number;
  now?: () => number;
}

export interface IngestResult {
  puuid: string;
  profile: PlayerProfile;
  fetchedMatchIds: string[];
  cachedMatchIds: string[];
}

/** "Name#TAG" (or "Name-TAG", handy in URLs) -> parts. */
export function parseRiotId(riotId: string): { gameName: string; tagLine: string } {
  const sep = riotId.includes('#') ? riotId.lastIndexOf('#') : riotId.lastIndexOf('-');
  if (sep <= 0 || sep === riotId.length - 1) throw new Error(`Invalid Riot ID "${riotId}", expected Name#TAG`);
  return { gameName: riotId.slice(0, sep), tagLine: riotId.slice(sep + 1) };
}

/**
 * One player's full ingestion run:
 * resolve PUUID -> match-id window + rank entry (in parallel) -> fetch only uncached matches -> aggregate.
 */
export async function ingestPlayer(deps: IngestDeps, platform: string, riotId: string): Promise<IngestResult> {
  const { client, store, matchWindow } = deps;
  const now = deps.now ?? Date.now;
  const region = platform.toLowerCase();
  const regional = regionalFor(region);
  const { gameName, tagLine } = parseRiotId(riotId);

  // 1. Riot ID -> PUUID
  const account = await client.getAccountByRiotId(regional, gameName, tagLine);
  const puuid = account.puuid;

  // 2. Match-id window, only newer than what's cached. 4. Rank entry, always fresh.
  const latest = store.playerSyncPoint(puuid);
  const [matchIds, leagueEntries] = await Promise.all([
    client.getMatchIds(regional, puuid, {
      count: matchWindow,
      startTime: latest === null ? undefined : Math.floor(latest / 1000),
    }),
    client.getLeagueEntries(region, puuid),
  ]);

  // 3. Cache check per match id; fetch only the uncached ones (the rate limiter paces these).
  const cachedMatchIds = matchIds.filter((id) => store.hasMatch(id));
  const fetchedMatchIds = matchIds.filter((id) => !store.hasMatch(id));
  const fetched: TftMatchDto[] = await Promise.all(fetchedMatchIds.map((id) => client.getMatch(regional, id)));
  for (const raw of fetched) store.saveMatch(raw, toMatchups(raw));

  store.upsertPlayer({
    puuid,
    gameName: account.gameName,
    tagLine: account.tagLine,
    region,
    lastMatchAt: store.newestMatchTime(matchIds),
  });
  const snapshot = toRankSnapshot(leagueEntries, now());
  if (snapshot) store.saveRankSnapshot(puuid, snapshot);

  // 5. Aggregate
  const profile = buildProfile({
    riotId: `${account.gameName}#${account.tagLine}`,
    region,
    matchups: store.getMatchups(puuid, matchWindow),
    snapshots: store.getRankSnapshots(puuid),
  });

  return { puuid, profile, fetchedMatchIds, cachedMatchIds };
}

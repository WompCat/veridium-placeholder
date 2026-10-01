import { loadProfile, type IngestDeps } from '../tft/ingest';
import type { PlayerSummary } from '../types';

/** A player's verified stats from the pipeline's cache, read at request time. No Riot calls. */
export function playerSummary(deps: IngestDeps, puuid: string): PlayerSummary | null {
  const player = deps.store.getPlayer(puuid);
  if (!player) return null;
  const p = loadProfile(deps, puuid, `${player.gameName}#${player.tagLine}`, player.region);
  return {
    puuid,
    riotId: p.riotId,
    region: p.region,
    verified: true,
    rank: p.rank,
    currentSet: p.currentSet,
    totalMatches: p.totalMatches,
    rankedMatches: p.rankedMatches,
    winRate: p.winRate,
    avgPlacement: p.avgPlacement,
  };
}

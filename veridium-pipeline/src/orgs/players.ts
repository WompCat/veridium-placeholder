import { LolStore, seasonOf } from '../lol/store';
import { ladderScore } from '../tft/aggregate';
import { loadProfile, type IngestDeps } from '../tft/ingest';
import type { PlayerSummary, RankEntry } from '../types';

/** Cached LoL summary for the current season, or null when the player hasn't been loaded for LoL. */
function lolSummary(deps: IngestDeps, puuid: string): PlayerSummary['lol'] {
  const lol = new LolStore(deps.store.db);
  if (!lol.hasPlayer(puuid)) return null;
  const solo = lol.latestRank(puuid, 'RANKED_SOLO_5x5');
  const { games, wins } = lol.seasonRecord(puuid, seasonOf((deps.now ?? Date.now)()));
  return {
    soloRank: solo ? { tier: solo.tier, division: solo.division, leaguePoints: solo.leaguePoints } : null,
    games,
    winRate: games ? Math.round((wins / games) * 1000) / 1000 : 0,
  };
}

function bestRank(tft: RankEntry | null, lol: RankEntry | null): PlayerSummary['bestRank'] {
  const options = [
    ...(tft ? [{ tier: tft.tier, division: tft.division, leaguePoints: tft.leaguePoints, game: 'tft' as const }] : []),
    ...(lol ? [{ ...lol, game: 'lol' as const }] : []),
  ];
  return options.sort((a, b) => ladderScore(b) - ladderScore(a))[0] ?? null;
}

/** A player's verified stats from the pipeline's cache, read at request time. No Riot calls. */
export function playerSummary(deps: IngestDeps, puuid: string): PlayerSummary | null {
  const player = deps.store.getPlayer(puuid);
  if (!player) return null;
  const p = loadProfile(deps, puuid, `${player.gameName}#${player.tagLine}`, player.region);
  const lol = lolSummary(deps, puuid);
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
    lol,
    bestRank: bestRank(p.rank, lol?.soloRank ?? null),
  };
}

import type { Matchup, PlayerProfile, RankEntry, RankSnapshot, RecentMatch } from '../types';

const TIERS = ['IRON', 'BRONZE', 'SILVER', 'GOLD', 'PLATINUM', 'EMERALD', 'DIAMOND', 'MASTER', 'GRANDMASTER', 'CHALLENGER'];
const DIVISIONS = ['IV', 'III', 'II', 'I'];
const APEX_START = TIERS.indexOf('MASTER');

/** Rank as a single number so LP changes can be computed across divisions and tiers. */
export function ladderScore(r: RankEntry): number {
  const tier = TIERS.indexOf(r.tier);
  // Master+ has no divisions; GM/Challenger are LP cutoffs on one shared ladder.
  if (tier >= APEX_START) return APEX_START * 400 + r.leaguePoints;
  return tier * 400 + DIVISIONS.indexOf(r.division) * 100 + r.leaguePoints;
}

export function formatRank(r: RankEntry): string {
  return TIERS.indexOf(r.tier) >= APEX_START ? r.tier : `${r.tier} ${r.division}`;
}

function gamesPlayed(s: RankSnapshot): number {
  return s.wins + s.losses;
}

function round(n: number, places: number): number {
  const f = 10 ** places;
  return Math.round(n * f) / f;
}

export function highestRank(snapshots: RankSnapshot[]): string | null {
  let best: RankSnapshot | null = null;
  for (const s of snapshots) {
    if (
      !best ||
      ladderScore(s) > ladderScore(best) ||
      (ladderScore(s) === ladderScore(best) && TIERS.indexOf(s.tier) > TIERS.indexOf(best.tier))
    ) {
      best = s;
    }
  }
  return best ? formatRank(best) : null;
}

/**
 * Riot has no per-match LP history, so it's derived from rank snapshots: when the snapshots
 * immediately before and after a ranked match are exactly one ranked game apart, the
 * difference between them is that match's LP change.
 */
function rankContext(m: Matchup, snapshots: RankSnapshot[], nextRankedAt: number) {
  if (m.queueType !== 'RANKED_TFT') return { lpChange: null, rankAfter: null };
  const t = Date.parse(m.timestamp);
  const before = snapshots.filter((s) => s.fetchedAt < t).at(-1);
  const after = snapshots.find((s) => s.fetchedAt > t);
  if (!after) return { lpChange: null, rankAfter: null };

  const rankAfter = after.fetchedAt < nextRankedAt ? formatRank(after) : null;
  const lpChange =
    before && gamesPlayed(after) === gamesPlayed(before) + 1 ? ladderScore(after) - ladderScore(before) : null;
  return { lpChange, rankAfter };
}

/** Matchups (newest first, already windowed) + rank snapshots (oldest first) -> profile response. */
export function buildProfile(input: {
  riotId: string;
  region: string;
  matchups: Matchup[];
  snapshots: RankSnapshot[];
}): PlayerProfile {
  const { matchups, snapshots } = input;
  const total = matchups.length;
  const top4 = matchups.filter((m) => m.placement <= 4).length;
  const firsts = matchups.filter((m) => m.placement === 1).length;
  const placementSum = matchups.reduce((sum, m) => sum + m.placement, 0);

  let nextRankedAt = Infinity;
  const recentMatches: RecentMatch[] = matchups.map((m) => {
    const ctx = rankContext(m, snapshots, nextRankedAt);
    if (m.queueType === 'RANKED_TFT') nextRankedAt = Date.parse(m.timestamp);
    return {
      matchId: m.matchId,
      date: m.timestamp.slice(0, 10),
      queueType: m.queueType,
      placement: m.placement,
      ...ctx,
    };
  });

  const current = snapshots.at(-1);
  return {
    riotId: input.riotId,
    region: input.region,
    verified: true,
    rank: current
      ? { tier: current.tier, division: current.division, leaguePoints: current.leaguePoints, percentile: null }
      : null,
    totalMatches: total,
    winRate: total ? round(top4 / total, 3) : 0,
    avgPlacement: total ? round(placementSum / total, 2) : 0,
    top1Rate: total ? round(firsts / total, 3) : 0,
    highestRank: highestRank(snapshots),
    recentMatches,
  };
}

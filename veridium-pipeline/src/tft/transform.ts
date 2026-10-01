import type { Matchup, QueueType, RankSnapshot, TftLeagueEntryDto, TftMatchDto } from '../types';

// TFT queue ids: 1100 = Ranked. Everything else (normal, Hyper Roll, Double Up, events) counts as normal.
const RANKED_QUEUE_ID = 1100;

export function queueTypeFor(queueId: number): QueueType {
  return queueId === RANKED_QUEUE_ID ? 'RANKED_TFT' : 'NORMAL_TFT';
}

/** One Matchup per participant in the match. */
export function toMatchups(raw: TftMatchDto): Array<{ puuid: string; matchup: Matchup }> {
  const queueType = queueTypeFor(raw.info.queue_id);
  const timestamp = new Date(raw.info.game_datetime).toISOString();
  return raw.info.participants.map((p) => ({
    puuid: p.puuid,
    matchup: {
      matchId: raw.metadata.match_id,
      queueType,
      placement: p.placement,
      timestamp,
      set: raw.info.tft_set_number,
    },
  }));
}

/** The player's ranked (standard ladder) entry from tft-league-v1, or null if unranked. */
export function toRankSnapshot(entries: TftLeagueEntryDto[], fetchedAt: number): RankSnapshot | null {
  const e = entries.find((x) => x.queueType === 'RANKED_TFT');
  if (!e || !e.tier) return null;
  return {
    tier: e.tier,
    division: e.rank ?? 'I',
    leaguePoints: e.leaguePoints ?? 0,
    wins: e.wins,
    losses: e.losses,
    fetchedAt,
  };
}

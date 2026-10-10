import type { LolParticipantRow } from './store';
import type { LolChampionStats, LolMatchRow, LolProfile, LolQueue, LolRank } from './types';

const QUEUES: Record<number, LolQueue> = { 420: 'RANKED_SOLO_5x5', 440: 'RANKED_FLEX_SR' };

const round = (n: number, places: number) => Math.round(n * 10 ** places) / 10 ** places;
const kdaOf = (rows: LolParticipantRow[]) => {
  const k = rows.reduce((t, r) => t + r.kills, 0);
  const d = rows.reduce((t, r) => t + r.deaths, 0);
  const a = rows.reduce((t, r) => t + r.assists, 0);
  return round((k + a) / Math.max(1, d), 2);
};

/** A season of ranked games (newest first) + current ranks -> the LoL profile response. */
export function buildLolProfile(input: {
  riotId: string;
  region: string;
  season: number;
  rows: LolParticipantRow[];
  ranks: { solo: LolRank | null; flex: LolRank | null };
  history: { complete: boolean; syncing: boolean };
}): LolProfile {
  const { rows } = input;
  const games = rows.length;
  const wins = rows.filter((r) => r.win).length;
  const minutes = rows.reduce((t, r) => t + r.duration, 0) / 60;

  const byChampion = new Map<string, LolParticipantRow[]>();
  const byRole = new Map<string, LolParticipantRow[]>();
  for (const r of rows) {
    byChampion.set(r.champion, [...(byChampion.get(r.champion) ?? []), r]);
    if (r.role) byRole.set(r.role, [...(byRole.get(r.role) ?? []), r]);
  }
  const champions: LolChampionStats[] = [...byChampion.entries()]
    .map(([champion, rs]) => {
      const w = rs.filter((r) => r.win).length;
      return { champion, games: rs.length, wins: w, winRate: round(w / rs.length, 3), kda: kdaOf(rs) };
    })
    .sort((a, b) => b.games - a.games || b.winRate - a.winRate || a.champion.localeCompare(b.champion));
  const roles = [...byRole.entries()]
    .map(([role, rs]) => ({ role, games: rs.length, winRate: round(rs.filter((r) => r.win).length / rs.length, 3) }))
    .sort((a, b) => b.games - a.games);

  const matches: LolMatchRow[] = rows.map((r) => ({
    matchId: r.matchId,
    date: new Date(r.gameEnd).toISOString().slice(0, 10),
    queue: QUEUES[r.queueId] ?? 'RANKED_SOLO_5x5',
    champion: r.champion,
    role: r.role,
    win: r.win,
    kills: r.kills,
    deaths: r.deaths,
    assists: r.assists,
    cs: r.cs,
    durationMin: round(r.duration / 60, 1),
  }));

  const avg = (key: 'kills' | 'deaths' | 'assists') => (games ? round(rows.reduce((t, r) => t + r[key], 0) / games, 1) : 0);
  return {
    game: 'lol',
    riotId: input.riotId,
    region: input.region,
    season: input.season,
    ranks: input.ranks,
    games,
    wins,
    winRate: games ? round(wins / games, 3) : 0,
    kills: avg('kills'),
    deaths: avg('deaths'),
    assists: avg('assists'),
    kda: games ? kdaOf(rows) : 0,
    csPerMin: minutes ? round(rows.reduce((t, r) => t + r.cs, 0) / minutes, 1) : 0,
    champions,
    roles,
    matches,
    history: input.history,
  };
}

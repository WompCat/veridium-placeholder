import type { LolLeagueEntryDto, LolMatchDto } from '../../src/lol/types';
import { ACCOUNT, PUUID } from './riot';

const DAY = 86_400_000;
export const SEASON_START = Date.UTC(2026, 0, 1);
export const NOW = Date.UTC(2026, 9, 10, 12); // Oct 10 2026

/** A ranked game for our player `n` days into the given year (higher n = newer). */
export function lolMatch(
  n: number,
  opts: { win: boolean; champion?: string; role?: string; k?: number; d?: number; a?: number; cs?: number; queueId?: number; year?: number },
): LolMatchDto {
  const end = Date.UTC(opts.year ?? 2026, 0, 1) + n * DAY;
  const me = {
    puuid: PUUID,
    championName: opts.champion ?? 'Ahri',
    teamPosition: opts.role ?? 'MIDDLE',
    win: opts.win,
    kills: opts.k ?? 5,
    deaths: opts.d ?? 3,
    assists: opts.a ?? 7,
    totalMinionsKilled: (opts.cs ?? 180) - 10,
    neutralMinionsKilled: 10,
  };
  const others = Array.from({ length: 9 }, (_, i) => ({
    ...me,
    puuid: `lol-lobby-${n}-${i}`,
    championName: 'Garen',
    win: i < 4 ? opts.win : !opts.win,
  }));
  const id = `NA1_${(opts.year ?? 2026) * 1000 + n}`;
  return {
    metadata: { matchId: id, participants: [me, ...others].map((p) => p.puuid) },
    info: { gameEndTimestamp: end, gameDuration: 30 * 60, queueId: opts.queueId ?? 420, participants: [me, ...others] },
  };
}

export const soloEntry = (tier: string, rank: string, lp: number, wins: number, losses: number): LolLeagueEntryDto => ({
  queueType: 'RANKED_SOLO_5x5', tier, rank, leaguePoints: lp, wins, losses,
});

/** fetch stand-in for the account + LoL endpoints; ids are paged by start/count like Riot. */
export function mockLolFetch(riot: { matches: LolMatchDto[]; league: LolLeagueEntryDto[] }) {
  const calls: string[] = [];
  const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
  const fetch = async (url: string): Promise<Response> => {
    calls.push(url);
    if (url.includes('/riot/account/v1/accounts/by-riot-id/')) return json(ACCOUNT);
    if (url.includes('/lol/match/v5/matches/by-puuid/')) {
      const all = [...riot.matches].sort((a, b) => b.info.gameEndTimestamp - a.info.gameEndTimestamp).map((m) => m.metadata.matchId);
      const q = new URL(url).searchParams;
      const start = Number(q.get('start') ?? 0);
      return json(all.slice(start, start + Number(q.get('count') ?? 20)));
    }
    if (url.includes('/lol/league/v4/entries/by-puuid/')) return json(riot.league);
    const id = url.match(/\/lol\/match\/v5\/matches\/([^/?]+)$/)?.[1];
    const m = riot.matches.find((x) => x.metadata.matchId === id);
    return m ? json(m) : new Response('{}', { status: 404 });
  };
  return {
    fetch,
    calls,
    matchCalls: () => calls.filter((c) => /\/lol\/match\/v5\/matches\/NA1_/.test(c)),
    idsCalls: () => calls.filter((c) => c.includes('/ids?')).map((c) => new URL(c).search),
  };
}

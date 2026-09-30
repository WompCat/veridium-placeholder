import type { RiotAccountDto, TftLeagueEntryDto, TftMatchDto } from '../../src/types';

export const PUUID = 'puuid-wompcat';
export const ACCOUNT: RiotAccountDto = { puuid: PUUID, gameName: 'WompCat', tagLine: 'NA1' };

const DAY = 86_400_000;
export const BASE_TIME = Date.UTC(2026, 8, 20, 18, 0, 0); // Sep 20 2026

/** A match where our player finished `placement`; the other 7 lobby slots are filled in. */
export function makeMatch(n: number, placement: number, queueId = 1100): TftMatchDto {
  const others = [1, 2, 3, 4, 5, 6, 7, 8].filter((p) => p !== placement);
  const participants = [
    { puuid: PUUID, placement },
    ...others.map((p, i) => ({ puuid: `lobby-${n}-${i}`, placement: p })),
  ];
  return {
    metadata: { match_id: `NA1_${1000 + n}`, participants: participants.map((p) => p.puuid) },
    info: { game_datetime: BASE_TIME + n * DAY, queue_id: queueId, tft_set_number: 15, participants },
  };
}

export function leagueEntry(tier: string, rank: string, lp: number, wins: number, losses: number): TftLeagueEntryDto[] {
  return [{ queueType: 'RANKED_TFT', tier, rank, leaguePoints: lp, wins, losses }];
}

interface MockRiot {
  account?: RiotAccountDto | null;
  matchIds: string[];
  matches: TftMatchDto[];
  league: TftLeagueEntryDto[];
  /** Responses to return (in order) before the real one, keyed by URL substring. */
  failures?: Record<string, Array<{ status: number; headers?: Record<string, string> }>>;
}

/** A fetch stand-in that routes Riot URLs to fixtures and records every call. */
export function mockRiotFetch(riot: MockRiot) {
  const calls: string[] = [];
  const fetch = async (url: string): Promise<Response> => {
    calls.push(url);
    for (const [key, queue] of Object.entries(riot.failures ?? {})) {
      if (url.includes(key) && queue.length) {
        const f = queue.shift()!;
        return new Response('{"status":{"message":"Rate limit exceeded"}}', { status: f.status, headers: f.headers });
      }
    }
    const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
    const notFound = () => new Response('{"status":{"message":"Data not found"}}', { status: 404 });

    if (url.includes('/riot/account/v1/accounts/by-riot-id/')) {
      return riot.account === null ? notFound() : json(riot.account ?? ACCOUNT);
    }
    if (url.includes('/tft/match/v1/matches/by-puuid/')) return json(riot.matchIds);
    if (url.includes('/tft/league/v1/by-puuid/')) return json(riot.league);
    const matchId = url.match(/\/tft\/match\/v1\/matches\/([^/?]+)$/)?.[1];
    const match = riot.matches.find((m) => m.metadata.match_id === matchId);
    return match ? json(match) : notFound();
  };
  return { fetch, calls, matchCalls: () => calls.filter((c) => /\/matches\/NA1_/.test(c)) };
}

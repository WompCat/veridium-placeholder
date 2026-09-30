import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Store } from '../src/cache/store';
import { RateLimiter, RiotClient } from '../src/riot/client';
import { createApp } from '../src/server';
import { buildProfile } from '../src/tft/aggregate';
import { ingestPlayer, parseRiotId } from '../src/tft/ingest';
import { toMatchups } from '../src/tft/transform';
import { BASE_TIME, PUUID, leagueEntry, makeMatch, mockRiotFetch } from './fixtures/riot';

const noSleep = async () => {};

function setup(riot: Parameters<typeof mockRiotFetch>[0], sleep = vi.fn(noSleep)) {
  const mock = mockRiotFetch(riot);
  const client = new RiotClient({ apiKey: 'test-key', fetch: mock.fetch, sleep, limiter: new RateLimiter([]) });
  return { mock, client, sleep };
}

let store: Store;
beforeEach(() => {
  store = new Store(':memory:');
});
afterEach(() => store.close());

describe('ingestPlayer', () => {
  it('fetches every match for a fresh player with nothing cached', async () => {
    const matches = [makeMatch(3, 1), makeMatch(2, 5), makeMatch(1, 4, 1090)];
    const { mock, client } = setup({
      matchIds: matches.map((m) => m.metadata.match_id),
      matches,
      league: leagueEntry('DIAMOND', 'IV', 42, 120, 110),
    });

    const result = await ingestPlayer({ client, store, matchWindow: 20 }, 'na1', 'WompCat#NA1');

    expect(result.fetchedMatchIds).toEqual(['NA1_1003', 'NA1_1002', 'NA1_1001']);
    expect(result.cachedMatchIds).toEqual([]);
    expect(mock.calls[0]).toBe('https://americas.api.riotgames.com/riot/account/v1/accounts/by-riot-id/WompCat/NA1');
    expect(mock.calls).toContain(`https://na1.api.riotgames.com/tft/league/v1/by-puuid/${PUUID}`);
    const idsCall = mock.calls.find((c) => c.includes('/ids?'))!;
    expect(idsCall).toContain('count=20');
    expect(idsCall).not.toContain('startTime');

    const p = result.profile;
    expect(p).toMatchObject({
      riotId: 'WompCat#NA1',
      region: 'na1',
      verified: true,
      rank: { tier: 'DIAMOND', division: 'IV', leaguePoints: 42, percentile: null },
      totalMatches: 3,
      winRate: 0.667, // 1st and 4th are top-4
      avgPlacement: 3.33,
      top1Rate: 0.333,
      highestRank: 'DIAMOND IV',
    });
    expect(p.recentMatches.map((m) => [m.matchId, m.placement, m.queueType])).toEqual([
      ['NA1_1003', 1, 'RANKED_TFT'],
      ['NA1_1002', 5, 'RANKED_TFT'],
      ['NA1_1001', 4, 'NORMAL_TFT'],
    ]);
    expect(p.recentMatches[0].date).toBe('2026-09-23');
  });

  it('only fetches matches that are not already cached', async () => {
    const m1 = makeMatch(1, 2);
    const m2 = makeMatch(2, 6);
    const first = setup({ matchIds: ['NA1_1002', 'NA1_1001'], matches: [m1, m2], league: [] });
    await ingestPlayer({ client: first.client, store, matchWindow: 20 }, 'na1', 'WompCat#NA1');

    // Two new games since; Riot also returns the boundary match we already have.
    const m3 = makeMatch(3, 1);
    const m4 = makeMatch(4, 3);
    const second = setup({
      matchIds: ['NA1_1004', 'NA1_1003', 'NA1_1002'],
      matches: [m1, m2, m3, m4],
      league: [],
    });
    const result = await ingestPlayer({ client: second.client, store, matchWindow: 20 }, 'na1', 'WompCat#NA1');

    expect(result.fetchedMatchIds).toEqual(['NA1_1004', 'NA1_1003']);
    expect(result.cachedMatchIds).toEqual(['NA1_1002']);
    expect(second.mock.matchCalls()).toHaveLength(2);
    expect(second.mock.calls.find((c) => c.includes('/ids?'))).toContain(
      `startTime=${Math.floor(m2.info.game_datetime / 1000)}`,
    );
    expect(result.profile.totalMatches).toBe(4);
    expect(result.profile.rank).toBeNull();
  });

  it("doesn't refetch a match cached from a lobby-mate, and doesn't use it as the player's cursor", async () => {
    const m1 = makeMatch(1, 7);
    const m2 = makeMatch(2, 1);
    store.saveMatch(m2, toMatchups(m2)); // cached when someone else in that lobby was ingested

    const { mock, client } = setup({ matchIds: ['NA1_1002', 'NA1_1001'], matches: [m1, m2], league: [] });
    const result = await ingestPlayer({ client, store, matchWindow: 20 }, 'na1', 'WompCat#NA1');

    expect(mock.calls.find((c) => c.includes('/ids?'))).not.toContain('startTime');
    expect(result.fetchedMatchIds).toEqual(['NA1_1001']);
    expect(result.cachedMatchIds).toEqual(['NA1_1002']);
    expect(result.profile.totalMatches).toBe(2);
  });

  it('retries a 429 after waiting the Retry-After interval', async () => {
    const m1 = makeMatch(1, 3);
    const { mock, client, sleep } = setup({
      matchIds: ['NA1_1001'],
      matches: [m1],
      league: leagueEntry('GOLD', 'II', 10, 5, 5),
      failures: { '/matches/NA1_1001': [{ status: 429, headers: { 'Retry-After': '2' } }] },
    });

    const result = await ingestPlayer({ client, store, matchWindow: 20 }, 'na1', 'WompCat#NA1');

    expect(sleep).toHaveBeenCalledWith(2000);
    expect(mock.matchCalls()).toHaveLength(2);
    expect(result.profile.totalMatches).toBe(1);
  });

  it('gives up after maxRetries and surfaces the status', async () => {
    const { client } = setup({
      matchIds: [],
      matches: [],
      league: [],
      failures: { '/riot/account/': Array(5).fill({ status: 429, headers: { 'Retry-After': '1' } }) },
    });
    await expect(ingestPlayer({ client, store, matchWindow: 20 }, 'na1', 'WompCat#NA1')).rejects.toMatchObject({
      status: 429,
    });
  });
});

describe('RateLimiter', () => {
  it('holds requests once a window is full', async () => {
    let t = 0;
    const waits: number[] = [];
    const limiter = new RateLimiter(
      [
        { limit: 2, windowMs: 1000 },
        { limit: 3, windowMs: 10_000 },
      ],
      () => t,
      async (ms) => {
        waits.push(ms);
        t += ms;
      },
    );
    await limiter.acquire();
    await limiter.acquire();
    await limiter.acquire(); // per-second window full -> waits 1s
    await limiter.acquire(); // 10s window full -> waits until the first request ages out
    expect(waits).toEqual([1000, 9000]);
  });
});

describe('buildProfile LP tracking', () => {
  it('derives lpChange when snapshots bracket exactly one ranked game', () => {
    const hour = 3_600_000;
    const snapshots = [
      { tier: 'DIAMOND', division: 'IV', leaguePoints: 90, wins: 10, losses: 10, fetchedAt: BASE_TIME },
      { tier: 'DIAMOND', division: 'III', leaguePoints: 20, wins: 11, losses: 10, fetchedAt: BASE_TIME + 2 * hour },
      { tier: 'DIAMOND', division: 'III', leaguePoints: 0, wins: 12, losses: 12, fetchedAt: BASE_TIME + 9 * hour },
    ];
    const at = (h: number) => new Date(BASE_TIME + h * hour).toISOString();
    const profile = buildProfile({
      riotId: 'WompCat#NA1',
      region: 'na1',
      snapshots,
      matchups: [
        { matchId: 'C', queueType: 'RANKED_TFT', placement: 7, timestamp: at(6) },
        { matchId: 'B', queueType: 'RANKED_TFT', placement: 5, timestamp: at(4) },
        { matchId: 'A', queueType: 'RANKED_TFT', placement: 1, timestamp: at(1) },
      ],
    });
    const byId = Object.fromEntries(profile.recentMatches.map((m) => [m.matchId, m]));
    expect(byId.A).toMatchObject({ lpChange: 30, rankAfter: 'DIAMOND III' }); // D4 90 -> D3 20
    expect(byId.B).toMatchObject({ lpChange: null, rankAfter: null }); // 3 games between snapshots
    expect(byId.C).toMatchObject({ lpChange: null, rankAfter: 'DIAMOND III' });
    expect(profile.highestRank).toBe('DIAMOND III');
  });
});

describe('parseRiotId', () => {
  it('accepts Name#TAG and Name-TAG', () => {
    expect(parseRiotId('Wom pCat#NA1')).toEqual({ gameName: 'Wom pCat', tagLine: 'NA1' });
    expect(parseRiotId('WompCat-NA1')).toEqual({ gameName: 'WompCat', tagLine: 'NA1' });
    expect(() => parseRiotId('WompCat')).toThrow();
  });
});

describe('GET /api/players/:region/:riotId/profile', () => {
  it('returns the profile', async () => {
    const m1 = makeMatch(1, 2);
    const { client } = setup({ matchIds: ['NA1_1001'], matches: [m1], league: leagueEntry('DIAMOND', 'IV', 42, 1, 0) });
    const app = createApp({ client, store, matchWindow: 20 });

    const res = await request(app).get('/api/players/na1/WompCat%23NA1/profile');

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ riotId: 'WompCat#NA1', verified: true, totalMatches: 1, winRate: 1 });
  });

  it('404s for an unknown Riot ID and 400s for an unknown region', async () => {
    const { client } = setup({ account: null, matchIds: [], matches: [], league: [] });
    const app = createApp({ client, store, matchWindow: 20 });

    expect((await request(app).get('/api/players/na1/Nobody%23NA1/profile')).status).toBe(404);
    expect((await request(app).get('/api/players/xx9/WompCat%23NA1/profile')).status).toBe(400);
  });
});

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
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

/** `count` matches in `set`, numbered downward from `newest`, placements cycling 1-8. */
function seasonOf(set: number, newest: number, count: number) {
  return Array.from({ length: count }, (_, i) => makeMatch(newest - i, (i % 8) + 1, 1100, set));
}

let store: Store;
beforeEach(() => {
  store = new Store(':memory:');
});
afterEach(() => store.close());

describe('ingestPlayer', () => {
  it('loads a fresh player: one page now, the rest of the seasons in the background', async () => {
    const matches = [...seasonOf(18, 200, 25), ...seasonOf(17, 170, 10)];
    const { mock, client } = setup({ matches, league: leagueEntry('DIAMOND', 'IV', 42, 120, 110) });

    const result = await ingestPlayer({ client, store, seasons: 3 }, 'na1', 'WompCat#NA1');

    expect(mock.calls[0]).toBe('https://americas.api.riotgames.com/riot/account/v1/accounts/by-riot-id/WompCat/NA1');
    expect(mock.calls).toContain(`https://na1.api.riotgames.com/tft/league/v1/by-puuid/${PUUID}`);
    expect(result.fetchedMatchIds).toHaveLength(20); // first page only
    expect(result.profile.history).toEqual({ complete: false, syncing: true });
    expect(result.profile.rank).toEqual({ tier: 'DIAMOND', division: 'IV', leaguePoints: 42, percentile: null });

    await result.history;
    expect(mock.matchCalls()).toHaveLength(35); // every match exactly once
    const { history, seasons, currentSet, totalMatches } = (
      await ingestPlayer({ client, store, seasons: 3 }, 'na1', 'WompCat#NA1')
    ).profile;
    expect(history).toEqual({ complete: true, syncing: false });
    expect(currentSet).toBe(18);
    expect(seasons.map((s) => [s.label, s.current, s.totalMatches])).toEqual([
      ['Set 18', true, 25],
      ['Set 17', false, 10],
      ['Set 16', false, 0],
    ]);
    expect(totalMatches).toBe(25);
  });

  it('computes per-season stats and keeps top-level stats for the current season', async () => {
    const matches = [makeMatch(13, 1), makeMatch(12, 5), makeMatch(11, 4, 1090), makeMatch(5, 8, 1100, 17)];
    const { client } = setup({ matches, league: [] });
    const { history } = await ingestPlayer({ client, store, seasons: 2 }, 'na1', 'WompCat#NA1');
    await history;
    const p = (await ingestPlayer({ client, store, seasons: 2 }, 'na1', 'WompCat#NA1')).profile;

    expect(p).toMatchObject({ totalMatches: 3, rankedMatches: 2, winRate: 0.667, avgPlacement: 3.33, top1Rate: 0.333 });
    expect(p.recentMatches.map((m) => [m.matchId, m.placement, m.queueType, m.set])).toEqual([
      ['NA1_1013', 1, 'RANKED_TFT', 18],
      ['NA1_1012', 5, 'RANKED_TFT', 18],
      ['NA1_1011', 4, 'NORMAL_TFT', 18],
    ]);
    expect(p.recentMatches[0].date).toBe('2026-10-03');
    expect(p.seasons[1]).toMatchObject({ set: 17, totalMatches: 1, winRate: 0, avgPlacement: 8 });
  });

  it('backfills through the tracked seasons and stops once past them', async () => {
    const matches = [
      ...seasonOf(18, 500, 25),
      ...seasonOf(17, 470, 15),
      makeMatch(455, 2, 1210, 4), // a revival-event game from an old set mid-history
      ...seasonOf(17, 450, 15),
      ...seasonOf(16, 430, 30),
      ...seasonOf(15, 390, 200),
    ];
    const { mock, client } = setup({ matches, league: [] });

    const { history } = await ingestPlayer({ client, store, seasons: 3 }, 'na1', 'WompCat#NA1');
    await history;

    // 86 in-season matches, then 10 of Set 15 reach the stop streak; the chunk of 20 rounds that to 100.
    expect(mock.matchCalls()).toHaveLength(100);
    expect(mock.idsCalls()).toEqual(['?start=0&count=20', '?start=0&count=100']);
    const p = (await ingestPlayer({ client, store, seasons: 3 }, 'na1', 'WompCat#NA1')).profile;
    expect(p.seasons.map((s) => s.totalMatches)).toEqual([25, 30, 30]);
    expect(p.history.complete).toBe(true);
  });

  it('only fetches new matches once history is complete', async () => {
    const old = [...seasonOf(18, 100, 30), ...seasonOf(17, 60, 5)];
    const first = setup({ matches: old, league: [] });
    await (await ingestPlayer({ client: first.client, store, seasons: 2 }, 'na1', 'WompCat#NA1')).history;

    const second = setup({ matches: [makeMatch(102, 1), makeMatch(101, 3), ...old], league: [] });
    const result = await ingestPlayer({ client: second.client, store, seasons: 2 }, 'na1', 'WompCat#NA1');

    expect(result.fetchedMatchIds).toEqual(['NA1_1102', 'NA1_1101']);
    expect(second.mock.matchCalls()).toHaveLength(2);
    expect(second.mock.idsCalls()).toEqual(['?start=0&count=20']); // no backfill
    expect(result.profile.history).toEqual({ complete: true, syncing: false });
    expect(result.profile.totalMatches).toBe(32);
  });

  it("doesn't refetch a match cached from a lobby-mate", async () => {
    const m1 = makeMatch(1, 7);
    const m2 = makeMatch(2, 1);
    store.saveMatch(m2, toMatchups(m2)); // cached when someone else in that lobby was ingested

    const { mock, client } = setup({ matches: [m1, m2], league: [] });
    const result = await ingestPlayer({ client, store, seasons: 3 }, 'na1', 'WompCat#NA1');
    await result.history;

    expect(result.fetchedMatchIds).toEqual(['NA1_1001']);
    expect(mock.matchCalls()).toHaveLength(1);
  });

  it('retries a 429 after waiting the Retry-After interval', async () => {
    const { mock, client, sleep } = setup({
      matches: [makeMatch(1, 3)],
      league: leagueEntry('GOLD', 'II', 10, 5, 5),
      failures: { '/matches/NA1_1001': [{ status: 429, headers: { 'Retry-After': '2' } }] },
    });

    const result = await ingestPlayer({ client, store, seasons: 3 }, 'na1', 'WompCat#NA1');

    expect(sleep).toHaveBeenCalledWith(2000);
    expect(mock.matchCalls()).toHaveLength(2);
    expect(result.profile.totalMatches).toBe(1);
  });

  it('gives up after maxRetries and surfaces the status', async () => {
    const { client } = setup({
      matches: [],
      league: [],
      failures: { '/riot/account/': Array(5).fill({ status: 429, headers: { 'Retry-After': '1' } }) },
    });
    await expect(ingestPlayer({ client, store, seasons: 3 }, 'na1', 'WompCat#NA1')).rejects.toMatchObject({
      status: 429,
    });
  });
});

describe('Store migration', () => {
  it('adds set numbers to a database created before seasons existed', () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'veridium-')), 'old.db');
    const old = new Database(file);
    old.exec(`CREATE TABLE players (puuid TEXT PRIMARY KEY, game_name TEXT NOT NULL, tag_line TEXT NOT NULL,
                region TEXT NOT NULL, last_match_at INTEGER, updated_at INTEGER NOT NULL);
              CREATE TABLE matches (match_id TEXT PRIMARY KEY, game_datetime INTEGER NOT NULL,
                queue_id INTEGER NOT NULL, raw_json TEXT NOT NULL);`);
    const m = makeMatch(1, 1, 1100, 17);
    old.prepare('INSERT INTO matches VALUES (?, ?, ?, ?)').run(m.metadata.match_id, 0, 1100, JSON.stringify(m));
    old.close();

    const migrated = new Store(file);
    expect(migrated.matchSet('NA1_1001')).toBe(17);
    expect(migrated.historyComplete('x', 17)).toBe(false);
    migrated.close();
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
      currentSet: 18,
      sets: [18],
      history: { complete: true, syncing: false },
      matchups: [
        { matchId: 'C', queueType: 'RANKED_TFT', placement: 7, timestamp: at(6), set: 18 },
        { matchId: 'B', queueType: 'RANKED_TFT', placement: 5, timestamp: at(4), set: 18 },
        { matchId: 'A', queueType: 'RANKED_TFT', placement: 1, timestamp: at(1), set: 18 },
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
  it('returns the profile, and serves it from cache with ?cached=1', async () => {
    const { client, mock } = setup({ matches: [makeMatch(1, 2)], league: leagueEntry('DIAMOND', 'IV', 42, 1, 0) });
    const app = createApp({ client, store, seasons: 3 });

    expect((await request(app).get('/api/players/na1/WompCat%23NA1/profile?cached=1')).status).toBe(404);

    const res = await request(app).get('/api/players/na1/WompCat%23NA1/profile');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ riotId: 'WompCat#NA1', verified: true, totalMatches: 1, winRate: 1 });
    await new Promise((r) => setTimeout(r, 20)); // let the background backfill finish

    const callsBefore = mock.calls.length;
    const cached = await request(app).get('/api/players/na1/wompcat-na1/profile?cached=1');
    expect(cached.status).toBe(200);
    expect(cached.body.seasons[0]).toMatchObject({ set: 18, totalMatches: 1 });
    expect(mock.calls.length).toBe(callsBefore);
  });

  it('404s for an unknown Riot ID and 400s for an unknown region', async () => {
    const { client } = setup({ account: null, matches: [], league: [] });
    const app = createApp({ client, store, seasons: 3 });

    expect((await request(app).get('/api/players/na1/Nobody%23NA1/profile')).status).toBe(404);
    expect((await request(app).get('/api/players/xx9/WompCat%23NA1/profile')).status).toBe(400);
  });
});

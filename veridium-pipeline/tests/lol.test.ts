import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Store } from '../src/cache/store';
import { ingestLol } from '../src/lol/ingest';
import { RateLimiter, RiotClient } from '../src/riot/client';
import { createApp } from '../src/server';
import { NOW, lolMatch, mockLolFetch, soloEntry } from './fixtures/lol';

let store: Store;
beforeEach(() => {
  store = new Store(':memory:');
});
afterEach(() => store.close());

function setup(riot: Parameters<typeof mockLolFetch>[0]) {
  const mock = mockLolFetch(riot);
  const client = new RiotClient({ apiKey: 'k', fetch: mock.fetch, sleep: async () => {}, limiter: new RateLimiter([]) });
  return { mock, deps: { client, store, seasons: 3, now: () => NOW } };
}

describe('ingestLol', () => {
  it('loads ranked games for the season and aggregates win rate, KDA, champions and roles', async () => {
    const matches = [
      lolMatch(30, { win: true, champion: 'Ahri', k: 10, d: 2, a: 8 }),
      lolMatch(29, { win: false, champion: 'Ahri', k: 2, d: 6, a: 4 }),
      lolMatch(28, { win: true, champion: 'Lux', role: 'UTILITY', k: 1, d: 1, a: 15, queueId: 440 }),
    ];
    const { mock, deps } = setup({ matches, league: [soloEntry('GOLD', 'II', 37, 40, 35)] });

    const first = await ingestLol(deps, 'na1', 'WompCat#NA1');
    await first.history;
    const p = (await ingestLol(deps, 'na1', 'WompCat#NA1')).profile;

    expect(mock.idsCalls().every((q) => q.includes('type=ranked'))).toBe(true);
    expect(mock.matchCalls()).toHaveLength(3); // each match fetched once
    expect(p).toMatchObject({
      game: 'lol',
      riotId: 'WompCat#NA1',
      season: 2026,
      ranks: { solo: { tier: 'GOLD', division: 'II', leaguePoints: 37, wins: 40, losses: 35 }, flex: null },
      games: 3,
      wins: 2,
      winRate: 0.667,
      kills: 4.3,
      deaths: 3,
      assists: 9,
      kda: 4.44, // (13 + 27) / 9
      csPerMin: 6,
      history: { complete: true, syncing: false },
    });
    expect(p.champions.map((c) => [c.champion, c.games, c.winRate])).toEqual([
      ['Ahri', 2, 0.5],
      ['Lux', 1, 1],
    ]);
    expect(p.roles).toEqual([
      { role: 'MIDDLE', games: 2, winRate: 0.5 },
      { role: 'UTILITY', games: 1, winRate: 1 },
    ]);
    expect(p.matches[0]).toMatchObject({ champion: 'Ahri', win: true, kills: 10, queue: 'RANKED_SOLO_5x5', cs: 180, date: '2026-01-31' });
    expect(p.matches[2].queue).toBe('RANKED_FLEX_SR');
  });

  it('backfills only the current season', async () => {
    const thisYear = Array.from({ length: 30 }, (_, i) => lolMatch(200 - i, { win: i % 2 === 0 }));
    const lastYear = Array.from({ length: 120 }, (_, i) => lolMatch(300 - i, { win: true, year: 2025 }));
    const { mock, deps } = setup({ matches: [...thisYear, ...lastYear], league: [] });

    const { history } = await ingestLol(deps, 'na1', 'WompCat#NA1');
    await history;

    // All 30 games this season, plus the 10 last-season games in the chunk where the stop streak is reached.
    expect(mock.matchCalls()).toHaveLength(40);
    expect(mock.idsCalls()).toEqual(['?type=ranked&start=0&count=20', '?type=ranked&start=0&count=100']);
    const p = (await ingestLol(deps, 'na1', 'WompCat#NA1')).profile;
    expect(p.games).toBe(30);
  });

  it('only fetches new games on later loads', async () => {
    const old = Array.from({ length: 5 }, (_, i) => lolMatch(100 - i, { win: true }));
    const first = setup({ matches: old, league: [] });
    await (await ingestLol(first.deps, 'na1', 'WompCat#NA1')).history;

    const second = setup({ matches: [lolMatch(101, { win: false }), ...old], league: [] });
    const r = await ingestLol(second.deps, 'na1', 'WompCat#NA1');
    expect(r.fetchedMatchIds).toEqual(['NA1_2026101']);
    expect(second.mock.idsCalls()).toEqual(['?type=ranked&start=0&count=20']);
    expect(r.profile.games).toBe(6);
  });
});

describe('GET /api/players/:region/:riotId/lol', () => {
  it('ingests, then serves from cache with ?cached=1', async () => {
    const { mock, deps } = setup({ matches: [lolMatch(5, { win: true })], league: [soloEntry('SILVER', 'I', 80, 3, 1)] });
    const app = createApp(deps);

    expect((await request(app).get('/api/players/na1/WompCat%23NA1/lol?cached=1')).status).toBe(404);
    const res = await request(app).get('/api/players/na1/WompCat%23NA1/lol');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ game: 'lol', games: 1, winRate: 1, ranks: { solo: { tier: 'SILVER' } } });

    await new Promise((r) => setTimeout(r, 20)); // let the background backfill settle
    const before = mock.calls.length;
    const cached = await request(app).get('/api/players/na1/wompcat-na1/lol?cached=1');
    expect(cached.status).toBe(200);
    expect(cached.body.games).toBe(1);
    expect(mock.calls.length).toBe(before);
  });
});

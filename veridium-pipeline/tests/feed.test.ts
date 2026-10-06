import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Store } from '../src/cache/store';
import { OrgRepo } from '../src/orgs/repo';
import { RiotClient } from '../src/riot/client';
import { createApp } from '../src/server';
import { toMatchups } from '../src/tft/transform';
import { BASE_TIME, PUUID, makeMatch } from './fixtures/riot';

const HOUR = 3_600_000;
let store: Store;
let orgs: OrgRepo;
let app: ReturnType<typeof createApp>;

/** A match on fixture day `n`, `hours` into that day. */
function matchAt(n: number, hours: number, placement: number, queueId = 1100) {
  const m = makeMatch(n, placement, queueId);
  m.metadata.match_id = `NA1_${n}_${hours}`;
  m.info.game_datetime = BASE_TIME + n * 86_400_000 + hours * HOUR;
  return m;
}

beforeEach(() => {
  store = new Store(':memory:');
  let tick = 0; // org events happen after the games, one minute apart
  orgs = new OrgRepo(store.db, () => new Date(BASE_TIME + 10 * 86_400_000 + tick++ * 60_000));
  app = createApp({ client: new RiotClient({ apiKey: '' }), store, seasons: 3 }, orgs);
  store.upsertPlayer({ puuid: PUUID, gameName: 'WompCat', tagLine: 'NA1', region: 'na1', lastMatchAt: null });
  store.upsertPlayer({ puuid: 'puuid-kairo', gameName: 'Kairo', tagLine: 'NA1', region: 'na1', lastMatchAt: null });
  // Two days of WompCat games: three on day 2, one on day 1.
  for (const m of [matchAt(2, 3, 1), matchAt(2, 2, 6), matchAt(2, 1, 4, 1090), matchAt(1, 1, 8)]) {
    store.saveMatch(m, toMatchups(m));
  }
  store.saveRankSnapshot(PUUID, { tier: 'GOLD', division: 'I', leaguePoints: 10, wins: 3, losses: 2, fetchedAt: 1 });
  orgs.createOrganization('Obscurity Esports');
});
afterEach(() => store.close());

describe('GET /api/feed', () => {
  it('groups each player-day of games into one session, alongside roster and vacancy events', async () => {
    orgs.createVacancy('obscurity-esports', { title: 'Flex Player', role: 'Flex', game: 'TFT', region: 'NA', level: 'competitive' });
    orgs.addMember('obscurity-esports', PUUID, 'Flex', 'active');

    const feed = (await request(app).get('/api/feed')).body;

    expect(feed.map((i: any) => i.type)).toEqual(['roster_join', 'vacancy', 'session', 'session']);
    const [join, , day2, day1] = feed;
    expect(join).toMatchObject({
      organization: { id: 'obscurity-esports', name: 'Obscurity Esports' },
      player: { riotId: 'WompCat#NA1' },
      role: 'Flex',
      roster: [{ riotId: 'WompCat#NA1', role: 'Flex' }],
    });
    expect(day2).toMatchObject({ date: '2026-09-22', rankedGames: 2, best: 1, avgPlacement: 3.7, set: 18 });
    expect(day2.games.map((g: any) => g.placement)).toEqual([1, 6, 4]);
    expect(day2.player).toMatchObject({ riotId: 'WompCat#NA1', rank: { tier: 'GOLD', division: 'I' } });
    expect(day1).toMatchObject({ date: '2026-09-21', games: [{ placement: 8 }] });
  });

  it("leaves out lobby-mates who haven't been loaded, and respects the limit", async () => {
    const feed = (await request(app).get('/api/feed?limit=1')).body;
    expect(feed).toHaveLength(1);
    const all = (await request(app).get('/api/feed')).body;
    expect(all.every((i: any) => i.player.riotId === 'WompCat#NA1')).toBe(true);
  });
});

describe('GET /api/players', () => {
  it('lists loaded players, ranked players first', async () => {
    const players = (await request(app).get('/api/players')).body;
    expect(players.map((p: any) => [p.riotId, p.rank?.tier ?? null, p.totalMatches])).toEqual([
      ['WompCat#NA1', 'GOLD', 4],
      ['Kairo#NA1', null, 0],
    ]);
  });
});

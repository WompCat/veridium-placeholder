import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Store } from '../src/cache/store';
import { OrgRepo } from '../src/orgs/repo';
import { RiotClient } from '../src/riot/client';
import { createApp } from '../src/server';
import { toMatchups } from '../src/tft/transform';
import { LolStore } from '../src/lol/store';
import { lolMatch } from './fixtures/lol';
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

describe('League of Legends in the feed', () => {
  it('groups ranked LoL games per player-day, leaving remakes out', async () => {
    const lol = new LolStore(store.db);
    // Sep 25 2026 is day 267 of the year: two wins and a loss, plus a remake.
    const day = 267;
    const games = [
      lolMatch(day, { win: true, champion: 'Jinx', role: 'BOTTOM', k: 7, d: 2, a: 9 }),
      lolMatch(day, { win: true, champion: 'Jinx', role: 'BOTTOM', k: 5, d: 1, a: 4 }),
      lolMatch(day, { win: false, champion: 'Ahri', role: 'MIDDLE', k: 2, d: 5, a: 3 }),
      lolMatch(day, { win: false, champion: 'Ahri', k: 0, d: 0, a: 0 }),
    ].map((m, i) => {
      m.metadata.matchId = `NA1_LOL${i}`;
      m.info.gameEndTimestamp += i * HOUR;
      return m;
    });
    games[3].info.participants.forEach((p) => (p.gameEndedInEarlySurrender = true));
    for (const m of games) lol.saveMatch(m);
    lol.saveRanks(PUUID, [{ queueType: 'RANKED_SOLO_5x5', tier: 'PLATINUM', rank: 'III', leaguePoints: 51, wins: 20, losses: 18 }], 1);

    const feed = (await request(app).get('/api/feed')).body;
    const lolItems = feed.filter((i: any) => i.type === 'lol_session');

    expect(lolItems).toHaveLength(1);
    expect(lolItems[0]).toMatchObject({
      date: '2026-09-25',
      wins: 2,
      losses: 1,
      kda: 3.75, // (14 + 16) / 8
      topChampion: 'Jinx',
      soloRank: { tier: 'PLATINUM', division: 'III', leaguePoints: 51 },
      player: { riotId: 'WompCat#NA1' },
    });
    expect(lolItems[0].games.map((g: any) => [g.matchId, g.win])).toEqual([
      ['NA1_LOL2', false],
      ['NA1_LOL1', true],
      ['NA1_LOL0', true],
    ]);
    // Newest first across games: the LoL day (Sep 25) sits between the TFT days (Sep 22 / 21) and later org events.
    expect(feed.map((i: any) => i.type)).toEqual(['lol_session', 'session', 'session']);
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

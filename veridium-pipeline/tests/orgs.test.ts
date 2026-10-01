import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Store } from '../src/cache/store';
import { OrgRepo } from '../src/orgs/repo';
import { RiotClient } from '../src/riot/client';
import { createApp } from '../src/server';
import { toMatchups } from '../src/tft/transform';
import { PUUID, makeMatch } from './fixtures/riot';

const ORG = 'obscurity-esports';
const KAIRO = 'puuid-kairo';

let store: Store;
let app: ReturnType<typeof createApp>;

/** Players as the pipeline leaves them: a players row plus cached matches. */
function seedPlayers() {
  store.upsertPlayer({ puuid: PUUID, gameName: 'WompCat', tagLine: 'NA1', region: 'na1', lastMatchAt: null });
  store.upsertPlayer({ puuid: KAIRO, gameName: 'Kairo', tagLine: 'NA1', region: 'na1', lastMatchAt: null });
  for (const m of [makeMatch(3, 1), makeMatch(2, 6), makeMatch(1, 3)]) store.saveMatch(m, toMatchups(m));
  store.saveRankSnapshot(PUUID, { tier: 'SILVER', division: 'III', leaguePoints: 60, wins: 16, losses: 17, fetchedAt: 1 });
}

beforeEach(() => {
  store = new Store(':memory:');
  seedPlayers();
  new OrgRepo(store.db).createOrganization('Obscurity Esports');
  // Org routes never call Riot; a client with no key would throw if they tried.
  app = createApp({ client: new RiotClient({ apiKey: '' }), store, seasons: 3 });
});
afterEach(() => store.close());

const api = () => request(app);

async function postVacancy(fields: Record<string, string> = {}) {
  const res = await api()
    .post(`/api/organizations/${ORG}/vacancies`)
    .send({ title: 'Flex Player', region: 'na', ...fields });
  expect(res.status).toBe(201);
  return res.body as { id: string };
}

async function apply(vacancyId: string, playerPuuid = PUUID) {
  return api().post(`/api/vacancies/${vacancyId}/applications`).send({ playerPuuid });
}

const roster = async () => (await api().get(`/api/organizations/${ORG}/roster`)).body as Array<Record<string, any>>;

describe('migrations', () => {
  it('applies each numbered migration once, and reopening the db is a no-op', () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'veridium-')), 'v.db');
    new Store(file).close();
    const reopened = new Store(file);
    const versions = reopened.db.prepare('SELECT version FROM schema_migrations ORDER BY version').all();
    expect(versions).toEqual([{ version: '001_pipeline.sql' }, { version: '002_organizations.sql' }]);
    const tables = reopened.db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all();
    expect(tables.map((t: any) => t.name)).toEqual(
      expect.arrayContaining(['organizations', 'org_memberships', 'vacancies', 'applications']),
    );
    reopened.close();
  });
});

describe('roster', () => {
  it('adds, updates and removes members, joining verified stats at read time', async () => {
    const added = await api().post(`/api/organizations/${ORG}/roster`).send({ playerPuuid: PUUID, role: 'TFT' });
    expect(added.status).toBe(201);
    expect(added.body).toMatchObject({ playerPuuid: PUUID, organizationId: ORG, role: 'TFT', status: 'active', leftAt: null });
    expect(added.body.player).toMatchObject({
      riotId: 'WompCat#NA1',
      verified: true,
      rank: { tier: 'SILVER', division: 'III', leaguePoints: 60 },
      totalMatches: 3,
      winRate: 0.667,
    });

    // By Riot ID, among players the pipeline has cached; starts on the bench.
    const byRiotId = await api()
      .post(`/api/organizations/${ORG}/roster`)
      .send({ riotId: 'kairo#na1', role: 'Sub', status: 'bench' });
    expect(byRiotId.status).toBe(201);

    const promoted = await api().patch(`/api/organizations/${ORG}/roster/${KAIRO}`).send({ status: 'active', role: 'DPS' });
    expect(promoted.body).toMatchObject({ role: 'DPS', status: 'active' });
    expect((await roster()).map((m) => [m.player.riotId, m.role, m.status])).toEqual([
      ['WompCat#NA1', 'TFT', 'active'],
      ['Kairo#NA1', 'DPS', 'active'],
    ]);

    const removed = await api().delete(`/api/organizations/${ORG}/roster/${PUUID}`);
    expect(removed.status).toBe(200);
    expect(removed.body.leftAt).toEqual(expect.any(String));
    expect((await roster()).map((m) => m.playerPuuid)).toEqual([KAIRO]);

    // Rejoining starts a new stint; the old one stays as history.
    expect((await api().post(`/api/organizations/${ORG}/roster`).send({ playerPuuid: PUUID, role: 'TFT' })).status).toBe(201);
    const stints = store.db.prepare('SELECT left_at FROM org_memberships WHERE player_puuid = ?').all(PUUID);
    expect(stints).toHaveLength(2);
  });

  it('rejects duplicates, unknown players, unknown orgs and bad input', async () => {
    await api().post(`/api/organizations/${ORG}/roster`).send({ playerPuuid: PUUID, role: 'TFT' });
    const dup = await api().post(`/api/organizations/${ORG}/roster`).send({ playerPuuid: PUUID, role: 'TFT' });
    expect(dup.status).toBe(409);
    expect((await api().post(`/api/organizations/${ORG}/roster`).send({ playerPuuid: 'nobody', role: 'TFT' })).status).toBe(404);
    expect((await api().post(`/api/organizations/${ORG}/roster`).send({ riotId: 'Ghost#NA1', role: 'TFT' })).status).toBe(404);
    expect((await api().get('/api/organizations/nope/roster')).status).toBe(404);
    expect((await api().post(`/api/organizations/${ORG}/roster`).send({ playerPuuid: KAIRO })).status).toBe(400);
    expect(
      (await api().post(`/api/organizations/${ORG}/roster`).send({ playerPuuid: KAIRO, role: 'X', status: 'retired' })).status,
    ).toBe(400);
    expect((await api().patch(`/api/organizations/${ORG}/roster/${KAIRO}`).send({ status: 'bench' })).status).toBe(404);
    const badJson = await api().post(`/api/organizations/${ORG}/roster`).set('Content-Type', 'application/json').send('{');
    expect(badJson.status).toBe(400);
  });
});

describe('vacancies', () => {
  it('posts a vacancy and lists it for the org and in the public listing', async () => {
    const v = await postVacancy();
    expect(v).toMatchObject({ organizationId: ORG, title: 'Flex Player', game: 'TFT', region: 'NA', level: 'competitive', status: 'open' });
    await postVacancy({ title: 'Support', game: 'Valorant', region: 'EU', level: 'casual' });

    const orgList = (await api().get(`/api/organizations/${ORG}/vacancies`)).body;
    expect(orgList).toHaveLength(2);

    const tftNa = (await api().get('/api/vacancies?game=tft&region=na')).body;
    expect(tftNa).toEqual([
      expect.objectContaining({ id: v.id, organizationName: 'Obscurity Esports', applicationCount: 0, pendingCount: 0 }),
    ]);
  });

  it('closes and reopens a vacancy', async () => {
    const v = await postVacancy();
    const closed = await api().patch(`/api/vacancies/${v.id}`).send({ status: 'closed' });
    expect(closed.body.status).toBe('closed');
    expect((await api().get('/api/vacancies')).body).toEqual([]);
    expect((await api().get('/api/vacancies?status=closed')).body).toHaveLength(1);

    await api().patch(`/api/vacancies/${v.id}`).send({ status: 'open' });
    expect((await api().get('/api/vacancies')).body).toHaveLength(1);
  });

  it('validates input', async () => {
    expect((await api().post(`/api/organizations/${ORG}/vacancies`).send({})).status).toBe(400);
    expect((await api().post(`/api/organizations/${ORG}/vacancies`).send({ title: 'X', level: 'pro' })).status).toBe(400);
    expect((await api().post('/api/organizations/nope/vacancies').send({ title: 'X' })).status).toBe(404);
    expect((await api().patch('/api/vacancies/missing').send({ status: 'closed' })).status).toBe(404);
    expect((await api().get('/api/vacancies?status=maybe')).status).toBe(400);
  });
});

describe('applications: the player ↔ org loop', () => {
  it('a player applies with their verified profile as the resume', async () => {
    const v = await postVacancy();
    const res = await apply(v.id);
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ vacancyId: v.id, playerPuuid: PUUID, status: 'pending' });
    expect(res.body.player).toMatchObject({ riotId: 'WompCat#NA1', verified: true, totalMatches: 3 });

    // Stats aren't copied into the application row.
    const columns = store.db.prepare('PRAGMA table_info(applications)').all().map((c: any) => c.name);
    expect(columns).toEqual(['id', 'vacancy_id', 'player_puuid', 'status', 'applied_at']);

    const list = (await api().get(`/api/vacancies/${v.id}/applications`)).body;
    expect(list).toEqual([expect.objectContaining({ id: res.body.id, player: expect.objectContaining({ riotId: 'WompCat#NA1' }) })]);
    expect((await api().get('/api/vacancies')).body[0]).toMatchObject({ applicationCount: 1, pendingCount: 1 });
  });

  it('accepting adds the player to the roster', async () => {
    const v = await postVacancy();
    const appId = (await apply(v.id)).body.id;

    const res = await api().patch(`/api/applications/${appId}`).send({ status: 'accepted' });

    expect(res.status).toBe(200);
    expect(res.body.application).toMatchObject({ id: appId, status: 'accepted' });
    expect(res.body.membership).toMatchObject({ playerPuuid: PUUID, organizationId: ORG, role: 'Flex Player', status: 'active' });
    expect((await roster()).map((m) => [m.playerPuuid, m.role])).toEqual([[PUUID, 'Flex Player']]);
    expect((await api().patch(`/api/applications/${appId}`).send({ status: 'rejected' })).status).toBe(409);
  });

  it('accepting can set the roster role and bench status', async () => {
    const v = await postVacancy();
    const appId = (await apply(v.id, KAIRO)).body.id;
    await api().patch(`/api/applications/${appId}`).send({ status: 'accepted', role: 'Sub', rosterStatus: 'bench' });
    expect((await roster()).map((m) => [m.playerPuuid, m.role, m.status])).toEqual([[KAIRO, 'Sub', 'bench']]);
  });

  it('rejecting leaves the roster unchanged', async () => {
    await api().post(`/api/organizations/${ORG}/roster`).send({ playerPuuid: KAIRO, role: 'DPS' });
    const v = await postVacancy();
    const appId = (await apply(v.id)).body.id;
    const before = await roster();

    const res = await api().patch(`/api/applications/${appId}`).send({ status: 'rejected' });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ application: { status: 'rejected' }, membership: null });
    expect(await roster()).toEqual(before);
  });

  it('rolls the application back if the roster insert fails', async () => {
    const v = await postVacancy();
    const appId = (await apply(v.id)).body.id;
    // The player joins the roster another way before the org decides.
    await api().post(`/api/organizations/${ORG}/roster`).send({ playerPuuid: PUUID, role: 'TFT' });

    expect((await api().patch(`/api/applications/${appId}`).send({ status: 'accepted' })).status).toBe(409);
    expect((await api().get(`/api/vacancies/${v.id}/applications`)).body[0].status).toBe('pending');
    expect((await roster()).map((m) => m.role)).toEqual(['TFT']);
  });

  it('blocks duplicate applications, closed vacancies and current members', async () => {
    const v = await postVacancy();
    await apply(v.id);
    expect((await apply(v.id)).status).toBe(409);

    await api().post(`/api/organizations/${ORG}/roster`).send({ playerPuuid: KAIRO, role: 'DPS' });
    expect((await apply(v.id, KAIRO)).status).toBe(409);

    await api().patch(`/api/vacancies/${v.id}`).send({ status: 'closed' });
    store.upsertPlayer({ puuid: 'puuid-zyn', gameName: 'Zyn', tagLine: 'NA1', region: 'na1', lastMatchAt: null });
    expect((await apply(v.id, 'puuid-zyn')).status).toBe(409);
    expect((await apply('missing')).status).toBe(404);
    expect((await api().patch('/api/applications/missing').send({ status: 'accepted' })).status).toBe(404);
    expect((await api().patch('/api/applications/missing').send({ status: 'maybe' })).status).toBe(400);
  });
});

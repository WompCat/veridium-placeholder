import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthRepo } from '../src/auth/repo';
import { Store } from '../src/cache/store';
import { OrgRepo } from '../src/orgs/repo';
import { RateLimiter, RiotClient } from '../src/riot/client';
import { createApp } from '../src/server';
import { isBackfilling } from '../src/tft/ingest';
import { PUUID, leagueEntry, makeMatch, mockRiotFetch } from './fixtures/riot';

const ORG = 'obscurity-esports';
const KAIRO = 'puuid-kairo';
const PASSWORD = 'correct horse battery';

let store: Store;
let auth: AuthRepo;
let now: Date;
let riot: ReturnType<typeof mockRiotFetch>;
let app: ReturnType<typeof createApp>;

beforeEach(() => {
  store = new Store(':memory:');
  store.upsertPlayer({ puuid: KAIRO, gameName: 'Kairo', tagLine: 'NA1', region: 'na1', lastMatchAt: null });
  new OrgRepo(store.db).createOrganization('Obscurity Esports');
  now = new Date('2026-10-10T12:00:00Z');
  auth = new AuthRepo(store.db, () => now);
  // WompCat isn't cached: signing up with that Riot ID loads it from (mock) Riot.
  riot = mockRiotFetch({ matches: [makeMatch(1, 2)], league: leagueEntry('GOLD', 'II', 10, 3, 2) });
  const client = new RiotClient({ apiKey: 'k', fetch: riot.fetch, sleep: async () => {}, limiter: new RateLimiter([]) });
  app = createApp({ client, store, seasons: 3 }, undefined, { auth });
});
afterEach(async () => {
  await vi.waitFor(() => expect(isBackfilling(PUUID)).toBe(false)); // let any history load finish first
  store.close();
});

const cookieOf = (res: request.Response) => (res.headers['set-cookie'] as unknown as string[] | undefined)?.[0] ?? '';
const session = (res: request.Response) => cookieOf(res).split(';')[0];

async function signup(fields: Record<string, unknown> = {}) {
  return request(app).post('/api/auth/signup').send({ email: 'womp@cat.gg', password: PASSWORD, ...fields });
}

describe('sign up, log in, log out', () => {
  it('signs up with a Riot ID loaded from Riot, and starts a session', async () => {
    const res = await signup({ email: 'Womp@Cat.gg', riotId: 'WompCat#NA1', region: 'na1' });
    expect(res.status).toBe(201);
    expect(res.body.user).toMatchObject({ email: 'womp@cat.gg', player: { puuid: PUUID, riotId: 'WompCat#NA1', region: 'na1' }, adminOf: [] });
    expect(res.body.user).not.toHaveProperty('passwordHash');
    expect(cookieOf(res)).toMatch(/^veridium_session=[\w-]+; Max-Age=2592000; Path=\/; Expires=.*; HttpOnly; SameSite=Lax$/);
    expect(riot.calls.some((c) => c.includes('/accounts/by-riot-id/WompCat/NA1'))).toBe(true);

    const me = await request(app).get('/api/auth/me').set('Cookie', session(res));
    expect(me.body.user).toMatchObject({ email: 'womp@cat.gg', player: { riotId: 'WompCat#NA1' } });
    expect((await request(app).get('/api/auth/me')).body).toEqual({ user: null });

    // Only a scrypt hash is stored, and only a hash of the session token.
    const row = store.db.prepare('SELECT password_hash FROM users').get() as { password_hash: string };
    expect(row.password_hash).toMatch(/^scrypt\$16384\$8\$1\$/);
    expect(row.password_hash).not.toContain(PASSWORD);
    const token = session(res).split('=')[1];
    expect(store.db.prepare('SELECT 1 FROM sessions WHERE token_hash = ?').get(token)).toBeUndefined();
  });

  it('signs up without a Riot ID (e.g. a recruiter) and links one later', async () => {
    const res = await signup();
    expect(res.body.user.player).toBeNull();
    const linked = await request(app).put('/api/auth/me/player').set('Cookie', session(res)).send({ riotId: 'kairo#na1', region: 'na1' });
    expect(linked.body.user.player).toMatchObject({ puuid: KAIRO, riotId: 'Kairo#NA1' });
    const unlinked = await request(app).put('/api/auth/me/player').set('Cookie', session(res)).send({ riotId: null });
    expect(unlinked.body.user.player).toBeNull();
    expect((await request(app).put('/api/auth/me/player').send({ riotId: 'kairo#na1' })).status).toBe(401);
  });

  it('validates input and refuses duplicate emails and Riot IDs', async () => {
    expect((await signup({ email: 'not-an-email' })).status).toBe(400);
    expect((await signup({ password: 'short' })).status).toBe(400);
    expect((await signup({ riotId: 'NoTag' })).status).toBe(400);
    expect((await signup({ riotId: 'Kairo#NA1', region: 'mars' })).status).toBe(400);

    expect((await signup({ riotId: 'Kairo#NA1' })).status).toBe(201);
    const dupEmail = await signup({ email: 'WOMP@cat.gg' });
    expect(dupEmail.status).toBe(409);
    expect(dupEmail.body.error).toMatch(/already exists/);
    const dupPlayer = await signup({ email: 'other@cat.gg', riotId: 'kairo#na1' });
    expect(dupPlayer.status).toBe(409);
    expect(dupPlayer.body.error).toMatch(/already linked/);
  });

  it("reports a Riot ID Riot doesn't know", async () => {
    riot = mockRiotFetch({ account: null, matches: [], league: [] });
    const client = new RiotClient({ apiKey: 'k', fetch: riot.fetch, sleep: async () => {}, limiter: new RateLimiter([]) });
    app = createApp({ client, store, seasons: 3 }, undefined, { auth });
    const res = await signup({ riotId: 'Ghost#NA1' });
    expect(res.status).toBe(404);
    expect(store.db.prepare('SELECT COUNT(*) AS n FROM users').get()).toEqual({ n: 0 });
  });

  it('logs in, logs out, and rejects wrong passwords with one message', async () => {
    await signup();
    const ok = await request(app).post('/api/auth/login').send({ email: 'WOMP@cat.gg', password: PASSWORD });
    expect(ok.status).toBe(200);
    const cookie = session(ok);
    expect((await request(app).get('/api/auth/me').set('Cookie', cookie)).body.user.email).toBe('womp@cat.gg');

    const wrong = await request(app).post('/api/auth/login').send({ email: 'womp@cat.gg', password: 'nope-nope' });
    const unknown = await request(app).post('/api/auth/login').send({ email: 'who@cat.gg', password: PASSWORD });
    expect([wrong.status, unknown.status]).toEqual([401, 401]);
    expect(wrong.body.error).toBe(unknown.body.error); // doesn't reveal which emails have accounts

    expect((await request(app).post('/api/auth/logout').set('Cookie', cookie)).status).toBe(204);
    expect((await request(app).get('/api/auth/me').set('Cookie', cookie)).body.user).toBeNull();
  });

  it('slows down password guessing', async () => {
    await signup();
    for (let i = 0; i < 10; i++) await request(app).post('/api/auth/login').send({ email: 'womp@cat.gg', password: `guess-${i}xx` });
    const blocked = await request(app).post('/api/auth/login').send({ email: 'womp@cat.gg', password: PASSWORD });
    expect(blocked.status).toBe(429);
  });

  it('expires sessions after 30 days', async () => {
    const cookie = session(await signup());
    now = new Date(now.getTime() + 31 * 86_400_000);
    expect((await request(app).get('/api/auth/me').set('Cookie', cookie)).body.user).toBeNull();
  });
});

describe('permissions', () => {
  async function account(email: string, puuid: string | null = null) {
    const user = auth.createUser(email, 'unused-hash', puuid);
    return { user, cookie: `veridium_session=${auth.createSession(user.id).token}` };
  }

  it("lets the first admin claim an unmanaged org, then only admins manage it", async () => {
    const owner = await account('owner@obscurity.gg');
    const stranger = await account('stranger@cat.gg');

    expect((await request(app).get(`/api/organizations/${ORG}`).set('Cookie', owner.cookie)).body.viewer)
      .toEqual({ loggedIn: true, isAdmin: false, canClaim: true });
    expect((await request(app).post(`/api/organizations/${ORG}/claim`)).status).toBe(401);
    expect((await request(app).post(`/api/organizations/${ORG}/claim`).set('Cookie', owner.cookie)).status).toBe(201);
    expect((await request(app).post(`/api/organizations/${ORG}/claim`).set('Cookie', stranger.cookie)).status).toBe(409);
    expect((await request(app).get(`/api/organizations/${ORG}`).set('Cookie', owner.cookie)).body.viewer)
      .toEqual({ loggedIn: true, isAdmin: true, canClaim: false });
    expect((await request(app).get('/api/auth/me').set('Cookie', owner.cookie)).body.user.adminOf)
      .toEqual([{ id: ORG, name: 'Obscurity Esports' }]);

    const post = (cookie?: string) => {
      const r = request(app).post(`/api/organizations/${ORG}/vacancies`);
      return (cookie ? r.set('Cookie', cookie) : r).send({ title: 'Flex Player' });
    };
    expect((await post()).status).toBe(401);
    expect((await post(stranger.cookie)).status).toBe(403);
    const vacancy = await post(owner.cookie);
    expect(vacancy.status).toBe(201);
    expect((await request(app).patch(`/api/vacancies/${vacancy.body.id}`).set('Cookie', stranger.cookie).send({ status: 'closed' })).status).toBe(403);
    expect((await request(app).post(`/api/organizations/${ORG}/roster`).set('Cookie', stranger.cookie).send({ playerPuuid: KAIRO, role: 'X' })).status).toBe(403);
    expect((await request(app).get(`/api/organizations/${ORG}/roster`)).status).toBe(200); // reading stays public
  });

  it('keeps applications private: players apply as themselves; only the org and the player see outcomes', async () => {
    const owner = await account('owner@obscurity.gg');
    auth.addOrgAdmin(ORG, owner.user.id);
    const kairo = await account('kairo@cat.gg', KAIRO);
    const recruiter = await account('recruiter@cat.gg'); // no Riot ID linked
    const vacancy = (await request(app).post(`/api/organizations/${ORG}/vacancies`).set('Cookie', owner.cookie).send({ title: 'Sub' })).body;
    const applyUrl = `/api/vacancies/${vacancy.id}/applications`;

    expect((await request(app).post(applyUrl).send({})).status).toBe(401);
    expect((await request(app).post(applyUrl).set('Cookie', recruiter.cookie).send({})).status).toBe(403);
    // The body can't apply as someone else: the account's own player is used.
    const applied = await request(app).post(applyUrl).set('Cookie', kairo.cookie).send({ playerPuuid: 'someone-else' });
    expect(applied.status).toBe(201);
    expect(applied.body.playerPuuid).toBe(KAIRO);

    // Applicants: org admins only.
    expect((await request(app).get(applyUrl).set('Cookie', kairo.cookie)).status).toBe(403);
    expect((await request(app).get(applyUrl).set('Cookie', owner.cookie)).body).toHaveLength(1);
    expect((await request(app).patch(`/api/applications/${applied.body.id}`).set('Cookie', kairo.cookie).send({ status: 'accepted' })).status).toBe(403);
    expect((await request(app).patch(`/api/applications/${applied.body.id}`).set('Cookie', owner.cookie).send({ status: 'rejected' })).status).toBe(200);

    // A player's applications: that player only.
    const mine = '/api/players/na1/Kairo%23NA1/applications';
    expect((await request(app).get(mine)).status).toBe(401);
    expect((await request(app).get(mine).set('Cookie', recruiter.cookie)).status).toBe(403);
    expect((await request(app).get(mine).set('Cookie', kairo.cookie)).body.map((a: any) => a.status)).toEqual(['rejected']);
  });
});

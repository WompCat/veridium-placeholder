import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AuthRepo } from '../src/auth/repo';
import { Store } from '../src/cache/store';
import { TERMS_VERSION } from '../src/legal';
import { RiotClient } from '../src/riot/client';
import { createApp } from '../src/server';
import { PUUID } from './fixtures/riot';

const KAIRO = 'puuid-kairo';
let store: Store;
let auth: AuthRepo;
let app: ReturnType<typeof createApp>;

beforeEach(() => {
  store = new Store(':memory:');
  store.upsertPlayer({ puuid: PUUID, gameName: 'WompCat', tagLine: 'NA1', region: 'na1', lastMatchAt: null });
  store.upsertPlayer({ puuid: KAIRO, gameName: 'Kairo', tagLine: 'NA1', region: 'na1', lastMatchAt: null });
  auth = new AuthRepo(store.db);
  // No Riot calls: both players are already cached.
  app = createApp({ client: new RiotClient({ apiKey: '' }), store, seasons: 3 }, undefined, { auth, adminEmails: ['staff@veridium.gg'] });
});
afterEach(() => store.close());

function account(email: string, puuid: string | null = null) {
  const user = auth.createUser(email, 'unused-hash', puuid, TERMS_VERSION);
  const cookie = `veridium_session=${auth.createSession(user.id).token}`;
  return {
    user,
    get: (url: string) => request(app).get(url).set('Cookie', cookie),
    post: (url: string) => request(app).post(url).set('Cookie', cookie),
    del: (url: string) => request(app).delete(url).set('Cookie', cookie),
  };
}

describe('tournament organizers', () => {
  it('apply → staff approve → post results that show on profiles; players can say "Not me"', async () => {
    const staff = account('staff@veridium.gg');
    const to = account('to@cups.gg');
    const kairo = account('kairo@cat.gg', KAIRO);
    const stranger = account('someone@cat.gg');

    // Apply.
    expect((await to.post('/api/organizers').send({})).status).toBe(400);
    expect((await to.post('/api/organizers').send({ name: 'NA Weekly Cups', website: 'cups.gg' })).status).toBe(400);
    const applied = await to.post('/api/organizers').send({ name: 'NA Weekly Cups', website: 'https://cups.gg', description: 'Weekly TFT cups.' });
    expect(applied.status).toBe(201);
    expect(applied.body.organizer.status).toBe('pending');
    expect((await to.post('/api/organizers').send({ name: 'Again' })).status).toBe(409);
    expect((await staff.get('/api/notifications')).body.items[0]).toMatchObject({ type: 'organizer.applied', link: 'admin.html' });

    // Pending organizers can't post; strangers and organizers can't approve.
    expect((await to.post('/api/tournaments').send({ name: 'Cup 1', game: 'TFT', date: '2026-09-27' })).status).toBe(403);
    expect((await to.get('/api/admin/organizers')).status).toBe(403);
    const pending = (await staff.get('/api/admin/organizers?status=pending')).body;
    expect(pending).toEqual([expect.objectContaining({ name: 'NA Weekly Cups', email: 'to@cups.gg' })]);
    expect((await stranger.post(`/api/admin/organizers/${pending[0].id}`).send({ status: 'approved' })).status).toBe(403);
    expect((await staff.post(`/api/admin/organizers/${pending[0].id}`).send({ status: 'approved' })).body.status).toBe('approved');
    expect((await to.get('/api/notifications')).body.items[0].type).toBe('organizer.approved');

    // Tournament and results.
    expect((await to.post('/api/tournaments').send({ name: 'Cup 1', game: 'TFT', date: '2099-01-01' })).status).toBe(400); // future
    expect((await to.post('/api/tournaments').send({ name: 'Cup 1', game: 'TFT', date: 'Sept 27' })).status).toBe(400);
    const cup = (await to.post('/api/tournaments').send({ name: 'Cup 1', game: 'TFT', date: '2026-09-27', region: 'NA' })).body;
    const url = `/api/tournaments/${cup.id}/results`;
    expect((await stranger.post(url).send({ riotId: 'Kairo#NA1', placement: 1 })).status).toBe(403);
    expect((await to.post(url).send({ riotId: 'Kairo#NA1', placement: 0 })).status).toBe(400);
    const first = await to.post(url).send({ riotId: 'kairo#na1', region: 'na1', placement: 1, team: 'Night Owls' });
    expect(first.status).toBe(201);
    expect(first.body.player.riotId).toBe('Kairo#NA1');
    expect((await to.post(url).send({ riotId: 'Kairo#NA1', placement: 2 })).status).toBe(409); // one result per player
    await to.post(url).send({ riotId: 'WompCat#NA1', placement: 3 });
    expect((await kairo.get('/api/notifications')).body.items[0].text).toBe('NA Weekly Cups recorded your 1st place at Cup 1.');

    // Public: list with podium, tournament page, the player's profile results.
    const list = (await request(app).get('/api/tournaments')).body;
    expect(list.map((t: any) => [t.name, t.organizerName, t.resultCount, t.podium.map((p: any) => p.player.riotId)]))
      .toEqual([['Cup 1', 'NA Weekly Cups', 2, ['Kairo#NA1', 'WompCat#NA1']]]);
    const kairoResults = (await request(app).get('/api/players/na1/Kairo%23NA1/tournaments')).body;
    expect(kairoResults).toEqual([expect.objectContaining({ placement: 1, team: 'Night Owls', tournament: expect.objectContaining({ name: 'Cup 1' }) })]);
    expect((await request(app).get(`/api/organizers/${pending[0].id}`)).body).toMatchObject({ name: 'NA Weekly Cups', tournaments: [expect.objectContaining({ name: 'Cup 1' })] });

    // "Not me": only the player; hides it from the profile and the public list, tells the organizer.
    const resultId = kairoResults[0].resultId;
    expect((await stranger.post(`/api/tournaments/results/${resultId}/not-me`)).status).toBe(403);
    expect((await kairo.post(`/api/tournaments/results/${resultId}/not-me`)).body).toEqual({ hidden: true });
    expect((await request(app).get('/api/players/na1/Kairo%23NA1/tournaments')).body).toEqual([]);
    expect((await request(app).get(`/api/tournaments/${cup.id}`)).body.results.map((r: any) => r.player.riotId)).toEqual(['WompCat#NA1']);
    const forTo = (await to.get(`/api/tournaments/${cup.id}`)).body;
    expect(forTo.results.map((r: any) => [r.player.riotId, r.hidden])).toEqual([['Kairo#NA1', true], ['WompCat#NA1', false]]);
    expect((await to.get('/api/notifications')).body.items[0].type).toBe('tournament.reported');

    // The organizer fixes it: delete the result, then the whole tournament.
    expect((await to.del(`${url}/${resultId}`)).status).toBe(204);
    expect((await stranger.del(`/api/tournaments/${cup.id}`)).status).toBe(403);
    expect((await to.del(`/api/tournaments/${cup.id}`)).status).toBe(204);
    expect((await request(app).get('/api/tournaments')).body).toEqual([]);
  });

  it("hides rejected and pending organizers' tournaments from the public", async () => {
    const staff = account('staff@veridium.gg');
    const to = account('to@cups.gg');
    const { organizer } = (await to.post('/api/organizers').send({ name: 'Shady Cups' })).body;
    await staff.post(`/api/admin/organizers/${organizer.id}`).send({ status: 'approved' });
    const cup = (await to.post('/api/tournaments').send({ name: 'Cup', game: 'TFT', date: '2026-09-01' })).body;
    await staff.post(`/api/admin/organizers/${organizer.id}`).send({ status: 'rejected' });
    expect((await request(app).get('/api/tournaments')).body).toEqual([]);
    expect((await request(app).get(`/api/tournaments/${cup.id}`)).status).toBe(404);
    expect((await request(app).get(`/api/organizers/${organizer.id}`)).status).toBe(404);
    expect((await to.get(`/api/tournaments/${cup.id}`)).status).toBe(200); // still visible to its organizer
  });
});

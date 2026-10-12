import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthRepo } from '../src/auth/repo';
import { Store } from '../src/cache/store';
import { BrevoMailer, createMailer, parseSender, type Mailer } from '../src/email';
import { TERMS_VERSION } from '../src/legal';
import { Notifier } from '../src/notifications';
import { RiotClient } from '../src/riot/client';
import { createApp } from '../src/server';
import { PUUID } from './fixtures/riot';

describe('Brevo mailer', () => {
  it('posts the notification to Brevo with a full link and a way to turn emails off', async () => {
    const fetchMock = vi.fn(async () => new Response('{"messageId":"x"}', { status: 201 }));
    const mailer = new BrevoMailer('xkeysib-test', { name: 'Veridium', email: 'noreply@veridium.gg' }, 'https://veridium.gg/', fetchMock as never);
    await mailer.send({ to: 'kairo@cat.gg', subject: 'Veridium: hi', text: 'Sweep <Gaming> accepted you.', link: 'org.html?id=sweep' });

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.brevo.com/v3/smtp/email');
    expect((init.headers as Record<string, string>)['api-key']).toBe('xkeysib-test');
    const sent = JSON.parse(String(init.body));
    expect(sent).toMatchObject({ sender: { name: 'Veridium', email: 'noreply@veridium.gg' }, to: [{ email: 'kairo@cat.gg' }], subject: 'Veridium: hi' });
    expect(sent.textContent).toContain('https://veridium.gg/org.html?id=sweep');
    expect(sent.textContent).toContain('https://veridium.gg/login.html#email');
    expect(sent.htmlContent).toContain('Sweep &lt;Gaming&gt;'); // escaped
  });

  it('throws when Brevo refuses, and stays off unless configured', async () => {
    const mailer = new BrevoMailer('bad', { name: 'V', email: 'a@b.co' }, '', (async () => new Response('unauthorized', { status: 401 })) as never);
    await expect(mailer.send({ to: 'a@b.co', subject: 's', text: 't', link: null })).rejects.toThrow(/401/);

    expect(createMailer({ brevoApiKey: '', emailFrom: 'a@b.co', siteUrl: '' })).toBeNull();
    expect(createMailer({ brevoApiKey: 'k', emailFrom: '', siteUrl: '' })).toBeNull();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(createMailer({ brevoApiKey: 'k', emailFrom: 'not an address', siteUrl: '' })).toBeNull();
    expect(createMailer({ brevoApiKey: 'k', emailFrom: 'Veridium <noreply@veridium.gg>', siteUrl: '' })).toBeInstanceOf(BrevoMailer);
    expect(parseSender('"Veridium Team" <hi@veridium.gg>')).toEqual({ name: 'Veridium Team', email: 'hi@veridium.gg' });
    expect(parseSender('hi@veridium.gg')).toEqual({ name: 'Veridium', email: 'hi@veridium.gg' });
  });
});

describe('notification emails', () => {
  let store: Store;
  let auth: AuthRepo;
  let sent: Array<{ to: string; subject: string; text: string; link: string | null }>;
  const fake: Mailer = { send: async (m) => { sent.push(m); } };

  beforeEach(() => {
    store = new Store(':memory:');
    store.upsertPlayer({ puuid: PUUID, gameName: 'WompCat', tagLine: 'NA1', region: 'na1', lastMatchAt: null });
    auth = new AuthRepo(store.db);
    sent = [];
  });
  afterEach(() => store.close());

  it('emails the same notification to accounts that have it on, and never to ones that turned it off', async () => {
    const app = createApp({ client: new RiotClient({ apiKey: '' }), store, seasons: 3 }, undefined, { auth, mailer: fake });
    const owner = auth.createUser('owner@org.gg', 'h', null, TERMS_VERSION);
    const player = auth.createUser('wompcat@cat.gg', 'h', PUUID, TERMS_VERSION);
    const ownerCookie = `veridium_session=${auth.createSession(owner.id).token}`;
    const playerCookie = `veridium_session=${auth.createSession(player.id).token}`;

    const me = await request(app).get('/api/auth/me').set('Cookie', playerCookie);
    expect(me.body.user).toMatchObject({ emailNotifications: true, emailAvailable: true });

    const org = (await request(app).post('/api/organizations').set('Cookie', ownerCookie).send({ name: 'Sweep Gaming' })).body;
    await request(app).post(`/api/organizations/${org.id}/roster`).set('Cookie', ownerCookie).send({ riotId: 'WompCat#NA1', region: 'na1', role: 'Mid' });
    await new Promise((r) => setTimeout(r, 10));
    expect(sent).toEqual([expect.objectContaining({ to: 'wompcat@cat.gg', text: 'Sweep Gaming added you to its roster as Mid.' })]);

    // Turned off: still on the site, no email.
    expect((await request(app).put('/api/auth/me/email-notifications').set('Cookie', playerCookie).send({ enabled: 'no' })).status).toBe(400);
    const off = await request(app).put('/api/auth/me/email-notifications').set('Cookie', playerCookie).send({ enabled: false });
    expect(off.body.user.emailNotifications).toBe(false);
    sent = [];
    await request(app).delete(`/api/organizations/${org.id}/roster/${PUUID}`).set('Cookie', ownerCookie);
    await new Promise((r) => setTimeout(r, 10));
    expect(sent).toEqual([]);
    expect((await request(app).get('/api/notifications').set('Cookie', playerCookie)).body.items[0].type).toBe('roster.removed');
  });

  it("a failing email service doesn't break anything, and email is reported off without a mailer", async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const user = auth.createUser('wompcat@cat.gg', 'h', PUUID, TERMS_VERSION);
    const notifier = new Notifier(store.db, { send: async () => { throw new Error('down'); } });
    store.db.prepare("INSERT INTO organizations (id, name, created_at) VALUES ('o', 'Org', '2026-01-01')").run();
    notifier.rosterAdded('o', PUUID, 'Mid');
    await notifier.idle();
    expect(notifier.list(user.id).unread).toBe(1);
    expect(new Notifier(store.db).emailEnabled).toBe(false);

    const app = createApp({ client: new RiotClient({ apiKey: '' }), store, seasons: 3 }, undefined, { auth });
    const cookie = `veridium_session=${auth.createSession(user.id).token}`;
    expect((await request(app).get('/api/auth/me').set('Cookie', cookie)).body.user.emailAvailable).toBe(false);
  });
});

import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Store } from '../src/cache/store';
import { RiotClient } from '../src/riot/client';
import { createApp } from '../src/server';

let store: Store;
beforeEach(() => {
  store = new Store(':memory:');
});
afterEach(() => store.close());

const app = (sitePassword?: string) =>
  createApp({ client: new RiotClient({ apiKey: '' }), store, seasons: 3 }, undefined, { sitePassword });
const basic = (user: string, pass: string) => `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}`;

describe('site password', () => {
  it('is off unless configured', async () => {
    expect((await request(app()).get('/api/vacancies')).status).toBe(200);
    expect((await request(app()).get('/org.html')).status).toBe(200);
  });

  it('gates pages and API behind HTTP Basic auth, any username', async () => {
    const gated = app('s3cret:with-colon');
    const noAuth = await request(gated).get('/org.html');
    expect(noAuth.status).toBe(401);
    expect(noAuth.headers['www-authenticate']).toMatch(/^Basic realm="Veridium"/);
    expect((await request(gated).get('/api/vacancies').set('Authorization', basic('x', 'wrong'))).status).toBe(401);
    expect((await request(gated).get('/api/vacancies').set('Authorization', 'Bearer s3cret:with-colon')).status).toBe(401);
    expect((await request(gated).get('/api/vacancies').set('Authorization', basic('anyone', 's3cret:with-colon'))).status).toBe(200);
    expect((await request(gated).get('/jobs.html').set('Authorization', basic('', 's3cret:with-colon'))).status).toBe(200);
  });

  it('leaves the health check open for the host', async () => {
    const res = await request(app('s3cret')).get('/api/health');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });
});

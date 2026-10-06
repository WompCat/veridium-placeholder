import { timingSafeEqual } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express, { type RequestHandler } from 'express';
import { Store } from './cache/store';
import { config } from './config';
import { RiotClient } from './riot/client';
import { OrgRepo } from './orgs/repo';
import {
  applicationsRouter,
  errorHandler,
  feedRouter,
  organizationsRouter,
  playerApplicationsRouter,
  vacanciesRouter,
} from './routes/organizations';
import { playersRouter } from './routes/players';
import type { IngestDeps } from './tft/ingest';

const publicDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');

/**
 * Optional site-wide password (HTTP Basic auth, any username). There are no accounts yet, so
 * this is what keeps a deployed prototype from being edited by anyone who finds the URL.
 */
function requirePassword(password: string): RequestHandler {
  const expected = Buffer.from(password);
  return (req, res, next) => {
    if (req.path === '/api/health') return next();
    const header = req.headers.authorization ?? '';
    const credentials = header.startsWith('Basic ') ? Buffer.from(header.slice(6), 'base64').toString() : '';
    const separator = credentials.indexOf(':'); // "username:password"; the username is ignored
    const given = Buffer.from(separator === -1 ? '' : credentials.slice(separator + 1));
    if (separator !== -1 && given.length === expected.length && timingSafeEqual(given, expected)) return next();
    res.set('WWW-Authenticate', 'Basic realm="Veridium", charset="UTF-8"').status(401).send('Password required');
  };
}

export function createApp(
  deps: IngestDeps,
  orgs = new OrgRepo(deps.store.db),
  opts: { sitePassword?: string } = {},
) {
  const app = express();
  if (opts.sitePassword) app.use(requirePassword(opts.sitePassword));
  app.use(express.json());
  app.use('/api/players', playersRouter(deps));
  const orgDeps = { ...deps, orgs };
  app.use('/api/players', playerApplicationsRouter(orgDeps));
  app.use('/api/organizations', organizationsRouter(orgDeps));
  app.use('/api/vacancies', vacanciesRouter(orgDeps));
  app.use('/api/applications', applicationsRouter(orgDeps));
  app.use('/api/feed', feedRouter(orgDeps));
  app.get('/api/health', (_req, res) => {
    res.json({ ok: true });
  });
  // Pages: Home (index.html), Players, Player Profile, Organizations, Org Dashboard, Tournaments, Jobs.
  app.use(express.static(publicDir));
  app.use(errorHandler); // e.g. malformed JSON bodies, rejected before reaching a router
  return app;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (!config.riotApiKey) console.warn('RIOT_API_KEY is not set: profile requests will fail until it is added to .env');
  const deps: IngestDeps = {
    client: new RiotClient({ apiKey: config.riotApiKey }),
    store: new Store(config.dbPath),
    seasons: config.seasons,
  };
  createApp(deps, undefined, { sitePassword: config.sitePassword }).listen(config.port, config.host, () => {
    console.log(`Veridium pipeline on http://${config.host}:${config.port}${config.sitePassword ? ' (password protected)' : ''}`);
    console.log(`Home: http://localhost:${config.port}/`);
    console.log(`Profile page: http://localhost:${config.port}/player.html?riotId=WompCat%23NA1&region=na1`);
    console.log(`Org dashboard: http://localhost:${config.port}/org.html?id=obscurity-esports`);
  });
}

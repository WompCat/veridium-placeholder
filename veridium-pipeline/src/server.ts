import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { Store } from './cache/store';
import { config } from './config';
import { RiotClient } from './riot/client';
import { OrgRepo } from './orgs/repo';
import { applicationsRouter, errorHandler, organizationsRouter, vacanciesRouter } from './routes/organizations';
import { playersRouter } from './routes/players';
import type { IngestDeps } from './tft/ingest';

const publicDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');

export function createApp(deps: IngestDeps, orgs = new OrgRepo(deps.store.db)) {
  const app = express();
  app.use(express.json());
  app.use('/api/players', playersRouter(deps));
  const orgDeps = { ...deps, orgs };
  app.use('/api/organizations', organizationsRouter(orgDeps));
  app.use('/api/vacancies', vacanciesRouter(orgDeps));
  app.use('/api/applications', applicationsRouter(orgDeps));
  app.get('/api/health', (_req, res) => {
    res.json({ ok: true });
  });
  // Player Profile (index.html), Org Dashboard (org.html) and Jobs (jobs.html) pages.
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
  createApp(deps).listen(config.port, () => {
    console.log(`Veridium pipeline on http://localhost:${config.port}`);
    console.log(`Profile page: http://localhost:${config.port}/?riotId=WompCat%23NA1&region=na1`);
    console.log(`Org dashboard: http://localhost:${config.port}/org.html?id=obscurity-esports`);
  });
}

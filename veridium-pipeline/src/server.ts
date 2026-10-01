import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { Store } from './cache/store';
import { config } from './config';
import { RiotClient } from './riot/client';
import { playersRouter } from './routes/players';
import type { IngestDeps } from './tft/ingest';

const publicDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');

export function createApp(deps: IngestDeps) {
  const app = express();
  app.use('/api/players', playersRouter(deps));
  app.get('/api/health', (_req, res) => {
    res.json({ ok: true });
  });
  // The Player Profile page, which calls /api/players/:region/:riotId/profile.
  app.use(express.static(publicDir));
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
  });
}

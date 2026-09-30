import { Router } from 'express';
import { RiotApiError } from '../riot/client';
import { isPlatform } from '../riot/regions';
import { ingestPlayer, parseRiotId, type IngestDeps } from '../tft/ingest';

export function playersRouter(deps: IngestDeps): Router {
  const router = Router();

  // riotId is "Name#TAG" URL-encoded (Name%23TAG), or "Name-TAG".
  router.get('/:region/:riotId/profile', async (req, res) => {
    const { region, riotId } = req.params;
    if (!isPlatform(region)) {
      res.status(400).json({ error: `Unknown region "${region}"` });
      return;
    }
    try {
      parseRiotId(riotId);
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
      return;
    }

    try {
      const { profile } = await ingestPlayer(deps, region, riotId);
      res.json(profile);
    } catch (err) {
      if (err instanceof RiotApiError) {
        if (err.status === 404) {
          res.status(404).json({ error: 'Player not found' });
          return;
        }
        if (err.status === 401 || err.status === 403) {
          res.status(502).json({ error: 'Riot API rejected the key (dev keys expire every 24h)' });
          return;
        }
        if (err.status === 429) {
          res.status(503).json({ error: 'Riot API rate limit reached, try again shortly' });
          return;
        }
      }
      console.error(err);
      res.status(502).json({ error: 'Failed to load player from Riot API' });
    }
  });

  return router;
}

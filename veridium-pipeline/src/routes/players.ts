import { Router } from 'express';
import { RiotApiError } from '../riot/client';
import { isPlatform } from '../riot/regions';
import { ingestPlayer, loadProfile, parseRiotId, type IngestDeps } from '../tft/ingest';

export function playersRouter(deps: IngestDeps): Router {
  const router = Router();

  // riotId is "Name#TAG" URL-encoded (Name%23TAG), or "Name-TAG".
  // ?cached=1 answers from the cache only (no Riot calls), for polling while history backfills.
  router.get('/:region/:riotId/profile', async (req, res) => {
    const { region, riotId } = req.params;
    if (!isPlatform(region)) {
      res.status(400).json({ error: `Unknown region "${region}"` });
      return;
    }
    let parsed: { gameName: string; tagLine: string };
    try {
      parsed = parseRiotId(riotId);
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
      return;
    }

    if (req.query.cached === '1') {
      const player = deps.store.findPlayer(parsed.gameName, parsed.tagLine, region);
      if (!player) {
        res.status(404).json({ error: 'Player not loaded yet' });
        return;
      }
      res.json(loadProfile(deps, player.puuid, `${player.gameName}#${player.tagLine}`, player.region));
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

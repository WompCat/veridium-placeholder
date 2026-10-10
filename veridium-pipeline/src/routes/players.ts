import { Router, type Request, type Response } from 'express';
import { hasLolData, ingestLol, loadLolProfile } from '../lol/ingest';
import { RiotApiError } from '../riot/client';
import { isPlatform } from '../riot/regions';
import { ingestPlayer, loadProfile, parseRiotId, type IngestDeps } from '../tft/ingest';

/** Validates :region and :riotId; sends a 400 and returns null when either is bad. */
function playerParams(req: Request, res: Response) {
  const { region, riotId } = req.params as { region: string; riotId: string };
  if (!isPlatform(region)) {
    res.status(400).json({ error: `Unknown region "${region}"` });
    return null;
  }
  try {
    return { region, riotId, ...parseRiotId(riotId) };
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
    return null;
  }
}

/** Turns a failed Riot call into a response the pages can show. */
function sendRiotError(res: Response, err: unknown) {
  if (err instanceof RiotApiError) {
    if (err.status === 404) {
      res.status(404).json({ error: 'No Riot account found for that Riot ID. Check the name, #tag and region.' });
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

export function playersRouter(deps: IngestDeps): Router {
  const router = Router();

  // riotId is "Name#TAG" URL-encoded (Name%23TAG), or "Name-TAG".
  // ?cached=1 answers from the cache only (no Riot calls), for polling while history backfills.
  router.get('/:region/:riotId/profile', async (req, res) => {
    const p = playerParams(req, res);
    if (!p) return;
    if (req.query.cached === '1') {
      const player = deps.store.findPlayer(p.gameName, p.tagLine, p.region);
      if (!player) {
        res.status(404).json({ error: 'Player not loaded yet' });
        return;
      }
      res.json(loadProfile(deps, player.puuid, `${player.gameName}#${player.tagLine}`, player.region));
      return;
    }
    try {
      res.json((await ingestPlayer(deps, p.region, p.riotId)).profile);
    } catch (err) {
      sendRiotError(res, err);
    }
  });

  // League of Legends: ranked Solo/Duo + Flex for the current season. Same ?cached=1 behaviour.
  router.get('/:region/:riotId/lol', async (req, res) => {
    const p = playerParams(req, res);
    if (!p) return;
    if (req.query.cached === '1') {
      const player = deps.store.findPlayer(p.gameName, p.tagLine, p.region);
      if (!player || !hasLolData(deps, player.puuid)) {
        res.status(404).json({ error: 'League of Legends not loaded for this player yet' });
        return;
      }
      res.json(loadLolProfile(deps, player.puuid, `${player.gameName}#${player.tagLine}`, player.region));
      return;
    }
    try {
      res.json((await ingestLol(deps, p.region, p.riotId)).profile);
    } catch (err) {
      sendRiotError(res, err);
    }
  });

  return router;
}

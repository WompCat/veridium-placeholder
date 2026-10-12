import { Router, type Request } from 'express';
import { isSiteAdmin, requireUser } from '../auth/http';
import { badRequest, forbidden, notFound } from '../orgs/errors';
import { playerSummary } from '../orgs/players';
import { parseRiotId } from '../tft/ingest';
import type { Organizer } from '../tournaments/repo';
import { resolveRiotId } from './auth';
import { errorHandler, type OrgDeps } from './organizations';

type Body = Record<string, unknown>;
const body = (req: Request): Body => (req.body && typeof req.body === 'object' ? (req.body as Body) : {});

function text(b: Body, key: string, max: number, required = false): string | null {
  const v = b[key];
  if (v === undefined || v === null || v === '') {
    if (required) throw badRequest(`"${key}" is required`);
    return null;
  }
  if (typeof v !== 'string' || !v.trim()) throw badRequest(`"${key}" must be text`);
  if (v.trim().length > max) throw badRequest(`"${key}" is too long`);
  return v.trim();
}

function website(b: Body): string | null {
  const site = text(b, 'website', 200);
  if (site && !/^https?:\/\/[^\s"'<>]+\.[^\s"'<>]+$/i.test(site)) throw badRequest('Website must be a full address starting with https://');
  return site;
}

/** What anyone may see about an organizer. */
const publicOrganizer = (o: Organizer) => ({ id: o.id, name: o.name, website: o.website, description: o.description, approvedAt: o.decidedAt });

/** /api/organizers: apply to be a tournament organizer, see your own status, public organizer pages. */
export function organizersRouter(deps: OrgDeps): Router {
  const router = Router();

  router.get('/me', (req, res) => {
    res.json({ organizer: deps.tournaments.organizerForUser(requireUser(req).id) });
  });

  router.post('/', (req, res) => {
    const user = requireUser(req);
    const b = body(req);
    const organizer = deps.tournaments.apply(user.id, {
      name: text(b, 'name', 80, true)!,
      website: website(b),
      description: text(b, 'description', 500),
    });
    deps.notifier.organizerApplied(deps.adminEmails, organizer.name);
    res.status(201).json({ organizer });
  });

  router.get('/:id', (req, res) => {
    const o = deps.tournaments.getOrganizer(String(req.params.id));
    if (!o || o.status !== 'approved') throw notFound('Organizer not found');
    res.json({ ...publicOrganizer(o), tournaments: deps.tournaments.listTournaments({ organizerId: o.id }) });
  });

  router.use(errorHandler);
  return router;
}

/** /api/admin: Veridium staff (ADMIN_EMAILS) review organizer applications. */
export function adminRouter(deps: OrgDeps): Router {
  const router = Router();
  const staff = (req: Request) => {
    const user = requireUser(req);
    if (!isSiteAdmin(user, deps.adminEmails)) throw forbidden('Only Veridium staff can do that.');
    return user;
  };

  router.get('/organizers', (req, res) => {
    staff(req);
    const status = typeof req.query.status === 'string' && req.query.status ? req.query.status : undefined;
    if (status && !['pending', 'approved', 'rejected'].includes(status)) throw badRequest('"status" must be pending, approved or rejected');
    res.json(deps.tournaments.listOrganizers(status as never).map((o) => ({
      ...o,
      email: deps.auth.getUser(o.userId)?.email ?? null, // staff need a way to check who's applying
    })));
  });

  router.post('/organizers/:id', (req, res) => {
    staff(req);
    const status = body(req).status;
    if (status !== 'approved' && status !== 'rejected') throw badRequest('"status" must be approved or rejected');
    const o = deps.tournaments.decide(String(req.params.id), status);
    deps.notifier.organizerDecided(o.userId, o.name, status);
    res.json(o);
  });

  router.use(errorHandler);
  return router;
}

/** /api/tournaments: public results from approved organizers; organizers manage their own. */
export function tournamentsRouter(deps: OrgDeps): Router {
  const { tournaments } = deps;
  const router = Router();

  /** The logged-in account's organizer profile, which must be approved. */
  const approvedOrganizer = (req: Request): Organizer => {
    const o = tournaments.organizerForUser(requireUser(req).id);
    if (!o) throw forbidden('Apply to be a tournament organizer first.');
    if (o.status !== 'approved') throw forbidden('Your organizer profile is waiting for Veridium to approve it.');
    return o;
  };
  /** A tournament this organizer owns. */
  const ownTournament = (req: Request) => {
    const o = approvedOrganizer(req);
    const t = tournaments.getTournament(String(req.params.id));
    if (!t) throw notFound('Tournament not found');
    if (t.organizerId !== o.id) throw forbidden('That tournament belongs to another organizer.');
    return t;
  };
  const withPlayers = (results: ReturnType<typeof tournaments.results>) =>
    results.flatMap((r) => {
      const player = playerSummary(deps, r.playerPuuid);
      return player ? [{ ...r, player }] : [];
    });

  router.get('/', (_req, res) => {
    res.json(tournaments.listTournaments().map((t) => ({ ...t, podium: withPlayers(tournaments.results(t.id).slice(0, 3)) })));
  });

  // An organizer's own tournaments, any status (their dashboard).
  router.get('/mine', (req, res) => {
    const o = tournaments.organizerForUser(requireUser(req).id);
    res.json(o ? tournaments.listTournaments({ organizerId: o.id }) : []);
  });

  router.get('/:id', (req, res) => {
    const t = tournaments.getTournament(String(req.params.id));
    const mine = !!req.user && tournaments.organizerForUser(req.user.id)?.id === t?.organizerId;
    if (!t || (!mine && !tournaments.getTournament(t.id, { publicOnly: true }))) throw notFound('Tournament not found');
    res.json({ ...t, results: withPlayers(tournaments.results(t.id, { includeHidden: mine })), mine });
  });

  router.post('/', (req, res) => {
    const o = approvedOrganizer(req);
    const b = body(req);
    const url = text(b, 'url', 300);
    if (url && !/^https?:\/\/[^\s"'<>]+\.[^\s"'<>]+$/i.test(url)) throw badRequest('Link must be a full address starting with https://');
    res.status(201).json(tournaments.createTournament(o.id, {
      name: text(b, 'name', 100, true)!,
      game: text(b, 'game', 40, true)!,
      date: text(b, 'date', 10, true)!,
      region: text(b, 'region', 20),
      url,
    }));
  });

  router.delete('/:id', (req, res) => {
    tournaments.deleteTournament(ownTournament(req).id);
    res.status(204).end();
  });

  // Record a placement by Riot ID (loaded from Riot if Veridium doesn't have the player yet).
  router.post('/:id/results', async (req, res) => {
    const t = ownTournament(req);
    const b = body(req);
    const riotId = text(b, 'riotId', 40, true)!;
    parseRiotId(riotId);
    const puuid = await resolveRiotId(deps, riotId, text(b, 'region', 10) ?? 'na1');
    const result = tournaments.addResult(t.id, puuid, Number(b.placement), text(b, 'team', 60));
    deps.notifier.tournamentResult(puuid, t.name, result.placement, t.organizerName);
    res.status(201).json({ ...result, player: playerSummary(deps, puuid) });
  });

  router.delete('/:id/results/:resultId', (req, res) => {
    const t = ownTournament(req);
    const r = tournaments.getResult(String(req.params.resultId));
    if (!r || r.tournamentId !== t.id) throw notFound('Result not found');
    tournaments.deleteResult(r.id);
    res.status(204).end();
  });

  // The player says a result isn't theirs: it disappears from their profile and the organizer is told.
  router.post('/results/:resultId/not-me', (req, res) => {
    const user = requireUser(req);
    const r = tournaments.getResult(String(req.params.resultId));
    if (!r) throw notFound('Result not found');
    if (r.playerPuuid !== user.playerPuuid) throw forbidden('You can only report results recorded for your own Riot ID.');
    tournaments.hideResult(r.id);
    const t = tournaments.getTournament(r.tournamentId)!;
    const organizer = tournaments.getOrganizer(t.organizerId)!;
    deps.notifier.resultReported(organizer.userId, r.playerPuuid, t.name);
    res.json({ hidden: true });
  });

  router.use(errorHandler);
  return router;
}

/** /api/players/:region/:riotId/tournaments: a player's visible results from approved organizers. */
export function playerTournamentsRouter(deps: OrgDeps): Router {
  const router = Router();
  router.get('/:region/:riotId/tournaments', (req, res) => {
    const { gameName, tagLine } = parseRiotId(String(req.params.riotId));
    const player = deps.store.findPlayer(gameName, tagLine, String(req.params.region));
    if (!player) throw notFound('Player not loaded yet');
    res.json(deps.tournaments.playerResults(player.puuid));
  });
  router.use(errorHandler);
  return router;
}

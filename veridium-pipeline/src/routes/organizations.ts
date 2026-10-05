import { Router, type ErrorRequestHandler, type Request } from 'express';
import { badRequest, HttpError, notFound } from '../orgs/errors';
import { playerSummary } from '../orgs/players';
import type { NewVacancy, OrgRepo, VacancyPatch } from '../orgs/repo';
import { parseRiotId, type IngestDeps } from '../tft/ingest';
import type { MembershipStatus, PlayerSummary, VacancyLevel, VacancyStatus } from '../types';

// No accounts or permissions exist yet: every route here is open. See README "Open decisions".

export interface OrgDeps extends IngestDeps {
  orgs: OrgRepo;
}

const MEMBERSHIP_STATUSES: MembershipStatus[] = ['active', 'bench'];
const VACANCY_LEVELS: VacancyLevel[] = ['competitive', 'casual'];
const VACANCY_STATUSES: VacancyStatus[] = ['open', 'closed'];

type Body = Record<string, unknown>;

function body(req: Request): Body {
  return req.body && typeof req.body === 'object' ? (req.body as Body) : {};
}

function text(b: Body, key: string, opts: { required: true; max?: number }): string;
function text(b: Body, key: string, opts?: { required?: false; max?: number }): string | undefined;
function text(b: Body, key: string, opts: { required?: boolean; max?: number } = {}): string | undefined {
  const value = b[key];
  if (value === undefined || value === null || value === '') {
    if (opts.required) throw badRequest(`"${key}" is required`);
    return undefined;
  }
  if (typeof value !== 'string' || !value.trim()) throw badRequest(`"${key}" must be a non-empty string`);
  if (value.length > (opts.max ?? 120)) throw badRequest(`"${key}" is too long`);
  return value.trim();
}

function oneOf<T extends string>(b: Body, key: string, allowed: T[], required = false): T | undefined {
  const value = required ? text(b, key, { required: true }) : text(b, key);
  if (value === undefined) return undefined;
  if (!allowed.includes(value as T)) throw badRequest(`"${key}" must be one of: ${allowed.join(', ')}`);
  return value as T;
}

function flag(b: Body, key: string): boolean | undefined {
  const value = b[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'boolean') throw badRequest(`"${key}" must be true or false`);
  return value;
}

/** A player by `playerPuuid`, or by `riotId` (+ `region`, default na1) among players the pipeline has cached. */
function resolvePlayer(deps: OrgDeps, b: Body): string {
  const puuid = text(b, 'playerPuuid', { max: 100 });
  if (puuid) return puuid;
  const riotId = text(b, 'riotId');
  if (!riotId) throw badRequest('"playerPuuid" or "riotId" is required');
  const { gameName, tagLine } = parseRiotId(riotId);
  const player = deps.store.findPlayer(gameName, tagLine, text(b, 'region') ?? 'na1');
  if (!player) throw notFound(`${riotId} hasn't been loaded yet. Open their player profile first.`);
  return player.puuid;
}

function summary(deps: OrgDeps, puuid: string): PlayerSummary {
  const s = playerSummary(deps, puuid);
  if (!s) throw notFound('Player not found');
  return s;
}

export const errorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
  if (err instanceof HttpError) {
    res.status(err.status).json({ error: err.message });
    return;
  }
  if (err?.type === 'entity.parse.failed') {
    res.status(400).json({ error: 'Request body must be valid JSON' });
    return;
  }
  if (err instanceof Error && /Invalid Riot ID/.test(err.message)) {
    res.status(400).json({ error: err.message });
    return;
  }
  console.error(err);
  res.status(500).json({ error: 'Internal error' });
};

/** /api/organizations: org details, roster management, an org's vacancies. */
export function organizationsRouter(deps: OrgDeps): Router {
  const { orgs } = deps;
  const router = Router();

  router.get('/:id', (req, res) => {
    const org = orgs.requireOrganization(req.params.id);
    res.json({ ...org, rosterSize: orgs.listRoster(org.id).length });
  });

  // Roster: current members joined against their verified player stats.
  router.get('/:id/roster', (req, res) => {
    const org = orgs.requireOrganization(req.params.id);
    res.json(orgs.listRoster(org.id).map((m) => ({ ...m, player: summary(deps, m.playerPuuid) })));
  });

  router.post('/:id/roster', (req, res) => {
    const b = body(req);
    const puuid = resolvePlayer(deps, b);
    const membership = orgs.addMember(
      req.params.id,
      puuid,
      text(b, 'role', { required: true, max: 40 }),
      oneOf(b, 'status', MEMBERSHIP_STATUSES) ?? 'active',
    );
    res.status(201).json({ ...membership, player: summary(deps, puuid) });
  });

  router.patch('/:id/roster/:playerPuuid', (req, res) => {
    const b = body(req);
    const patch = { role: text(b, 'role', { max: 40 }), status: oneOf(b, 'status', MEMBERSHIP_STATUSES) };
    if (!patch.role && !patch.status) throw badRequest('Nothing to update: send "role" and/or "status"');
    const membership = orgs.updateMember(req.params.id, req.params.playerPuuid, {
      ...(patch.role && { role: patch.role }),
      ...(patch.status && { status: patch.status }),
    });
    res.json({ ...membership, player: summary(deps, membership.playerPuuid) });
  });

  router.delete('/:id/roster/:playerPuuid', (req, res) => {
    res.json(orgs.removeMember(req.params.id, req.params.playerPuuid));
  });

  // Vacancies for one org (all statuses).
  router.get('/:id/vacancies', (req, res) => {
    const org = orgs.requireOrganization(req.params.id);
    res.json(orgs.listVacancies({ organizationId: org.id }));
  });

  router.post('/:id/vacancies', (req, res) => {
    const b = body(req);
    const vacancy: NewVacancy = {
      title: text(b, 'title', { required: true, max: 80 }),
      game: text(b, 'game', { max: 40 }) ?? 'TFT',
      region: (text(b, 'region', { max: 10 }) ?? 'NA').toUpperCase(),
      role: text(b, 'role', { max: 40 }) ?? null,
      level: oneOf(b, 'level', VACANCY_LEVELS) ?? 'competitive',
    };
    res.status(201).json(orgs.createVacancy(req.params.id, vacancy));
  });

  router.use(errorHandler);
  return router;
}

/** /api/vacancies: the public listing, open/close, and applications. */
export function vacanciesRouter(deps: OrgDeps): Router {
  const { orgs } = deps;
  const router = Router();

  // What a player browses: open postings across all orgs, filterable by game, region and role.
  router.get('/', (req, res) => {
    const q = (key: string) => (typeof req.query[key] === 'string' && req.query[key] ? String(req.query[key]) : undefined);
    const status = q('status') ?? 'open';
    if (status !== 'all' && !VACANCY_STATUSES.includes(status as VacancyStatus)) {
      throw badRequest('"status" must be open, closed or all');
    }
    res.json(
      orgs.listVacancies({
        status: status === 'all' ? undefined : (status as VacancyStatus),
        game: q('game'),
        region: q('region'),
        role: q('role'),
      }),
    );
  });

  router.patch('/:id', (req, res) => {
    const b = body(req);
    const patch: VacancyPatch = {
      title: text(b, 'title', { max: 80 }),
      game: text(b, 'game', { max: 40 }),
      region: text(b, 'region', { max: 10 })?.toUpperCase(),
      role: text(b, 'role', { max: 40 }),
      level: oneOf(b, 'level', VACANCY_LEVELS),
      status: oneOf(b, 'status', VACANCY_STATUSES),
    };
    const changes = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)) as VacancyPatch;
    if (!Object.keys(changes).length) throw badRequest('Nothing to update');
    res.json(orgs.updateVacancy(req.params.id, changes));
  });

  // A player applies; their verified profile is their resume, read live, never copied into the application.
  router.post('/:id/applications', (req, res) => {
    const puuid = resolvePlayer(deps, body(req));
    const application = orgs.createApplication(req.params.id, puuid);
    res.status(201).json({ ...application, player: summary(deps, puuid) });
  });

  router.get('/:id/applications', (req, res) => {
    const vacancy = orgs.requireVacancy(req.params.id);
    res.json(
      orgs.listApplications(vacancy.id).map((a) => ({
        ...a,
        player: summary(deps, a.playerPuuid),
        onRoster: orgs.isOnRoster(a),
      })),
    );
  });

  router.use(errorHandler);
  return router;
}

/**
 * /api/applications: accept or reject. Accepting adds the player to the roster in the same
 * transaction unless `addToRoster: false`; POST /:id/roster adds an accepted applicant later.
 */
export function applicationsRouter(deps: OrgDeps): Router {
  const { orgs } = deps;
  const router = Router();

  router.patch('/:id', (req, res) => {
    const b = body(req);
    const decision = oneOf(b, 'status', ['accepted', 'rejected'], true)!;
    const result = orgs.decideApplication(req.params.id, decision, {
      addToRoster: flag(b, 'addToRoster'),
      role: text(b, 'role', { max: 40 }),
      status: oneOf(b, 'rosterStatus', MEMBERSHIP_STATUSES),
    });
    res.json(result);
  });

  // One click from the applicants view: roster entry pre-filled from the application and vacancy.
  router.post('/:id/roster', (req, res) => {
    const b = body(req);
    const membership = orgs.addApplicantToRoster(req.params.id, {
      role: text(b, 'role', { max: 40 }),
      status: oneOf(b, 'status', MEMBERSHIP_STATUSES),
    });
    res.status(201).json({ ...membership, player: summary(deps, membership.playerPuuid) });
  });

  router.use(errorHandler);
  return router;
}

/** /api/players/:region/:riotId/applications: a player's own applications and their status (cache only). */
export function playerApplicationsRouter(deps: OrgDeps): Router {
  const router = Router();

  router.get('/:region/:riotId/applications', (req, res) => {
    const { gameName, tagLine } = parseRiotId(req.params.riotId);
    const player = deps.store.findPlayer(gameName, tagLine, req.params.region);
    res.json(player ? deps.orgs.listPlayerApplications(player.puuid) : []);
  });

  router.use(errorHandler);
  return router;
}

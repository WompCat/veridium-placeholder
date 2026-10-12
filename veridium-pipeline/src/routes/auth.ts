import { Router, type Request } from 'express';
import { DUMMY_HASH, hashPassword, verifyPassword } from '../auth/passwords';
import type { AuthRepo, User } from '../auth/repo';
import { clearSessionCookie, isSiteAdmin, requireSession, requireUser, sessionToken, setSessionCookie } from '../auth/http';
import { TERMS_VERSION } from '../legal';
import { badRequest, HttpError, notFound } from '../orgs/errors';
import { RiotApiError } from '../riot/client';
import { isPlatform } from '../riot/regions';
import { ingestPlayer, parseRiotId } from '../tft/ingest';
import { errorHandler, type OrgDeps } from './organizations';

export interface AuthDeps extends OrgDeps {
  auth: AuthRepo;
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MIN_PASSWORD = 8;

type Body = Record<string, unknown>;
const body = (req: Request): Body => (req.body && typeof req.body === 'object' ? (req.body as Body) : {});
const str = (b: Body, key: string) => (typeof b[key] === 'string' ? (b[key] as string).trim() : '');

/** What the pages get for the logged-in account. Never includes the password hash. */
function accountView(deps: AuthDeps, user: User) {
  const player = user.playerPuuid ? deps.store.getPlayer(user.playerPuuid) : null;
  return {
    id: user.id,
    email: user.email,
    player: player ? { puuid: player.puuid, riotId: `${player.gameName}#${player.tagLine}`, region: player.region } : null,
    adminOf: deps.auth.adminOrgs(user.id),
    termsAccepted: user.termsVersion === TERMS_VERSION,
    siteAdmin: isSiteAdmin(user, deps.adminEmails),
    lookingForTeam: user.lookingForTeam,
    lftRoles: user.lftRoles,
    emailNotifications: user.emailNotifications,
    emailAvailable: deps.notifier.emailEnabled,
    termsAcceptedAt: user.termsAcceptedAt,
  };
}

/** The Riot ID's PUUID: from the cache, or loaded from Riot (which also verifies the account exists). */
export async function resolveRiotId(deps: AuthDeps, riotId: string, region: string): Promise<string> {
  if (!isPlatform(region)) throw badRequest(`Unknown region "${region}"`);
  const { gameName, tagLine } = parseRiotId(riotId);
  const cached = deps.store.findPlayer(gameName, tagLine, region);
  if (cached) return cached.puuid;
  try {
    return (await ingestPlayer(deps, region, riotId)).puuid;
  } catch (err) {
    if (err instanceof RiotApiError && err.status === 404) {
      throw notFound('No Riot account found for that Riot ID. Check the name, #tag and region.');
    }
    console.error(err);
    throw new HttpError(502, "Couldn't reach Riot to check that Riot ID. Try again in a minute.");
  }
}

/** Failed logins per email: a few guesses are fine, a password-guessing run is not. */
class LoginThrottle {
  private failures = new Map<string, number[]>();
  constructor(
    private max = 10,
    private windowMs = 15 * 60_000,
    private now: () => number = Date.now,
  ) {}
  check(key: string) {
    const recent = (this.failures.get(key) ?? []).filter((t) => t > this.now() - this.windowMs);
    this.failures.set(key, recent);
    if (recent.length >= this.max) throw new HttpError(429, 'Too many attempts. Wait a few minutes and try again.');
  }
  fail(key: string) {
    this.failures.set(key, [...(this.failures.get(key) ?? []), this.now()]);
  }
  clear(key: string) {
    this.failures.delete(key);
  }
}

/** /api/auth: sign up, log in, log out, the current account, and linking a Riot ID. */
export function authRouter(deps: AuthDeps): Router {
  const { auth } = deps;
  const router = Router();
  const throttle = new LoginThrottle();

  router.get('/me', (req, res) => {
    res.json({ user: req.user ? accountView(deps, req.user) : null });
  });

  router.post('/signup', async (req, res) => {
    const b = body(req);
    const email = str(b, 'email').toLowerCase();
    const password = typeof b.password === 'string' ? b.password : '';
    if (!EMAIL.test(email) || email.length > 254) throw badRequest('Enter a valid email address.');
    if (password.length < MIN_PASSWORD) throw badRequest(`Use a password of at least ${MIN_PASSWORD} characters.`);
    if (password.length > 200) throw badRequest('That password is too long.');
    if (b.acceptTerms !== true) throw badRequest('Please accept the Terms of Service and Privacy Policy to create an account.');
    if (auth.findByEmail(email)) throw new HttpError(409, 'An account with that email already exists. Log in instead.');

    const riotId = str(b, 'riotId');
    const puuid = riotId ? await resolveRiotId(deps, riotId, str(b, 'region') || 'na1') : null;
    const user = auth.createUser(email, await hashPassword(password), puuid, TERMS_VERSION);
    setSessionCookie(req, res, auth.createSession(user.id).token);
    res.status(201).json({ user: accountView(deps, user) });
  });

  router.post('/login', async (req, res) => {
    const b = body(req);
    const email = str(b, 'email').toLowerCase();
    const password = typeof b.password === 'string' ? b.password : '';
    throttle.check(email);
    const user = auth.findByEmail(email);
    const ok = await verifyPassword(password, user?.passwordHash ?? DUMMY_HASH);
    if (!user || !ok) {
      throttle.fail(email);
      throw new HttpError(401, 'That email and password don’t match an account.');
    }
    throttle.clear(email);
    setSessionCookie(req, res, auth.createSession(user.id).token);
    res.json({ user: accountView(deps, user) });
  });

  router.post('/logout', (req, res) => {
    const token = sessionToken(req);
    if (token) auth.deleteSession(token);
    clearSessionCookie(req, res);
    res.status(204).end();
  });

  // Accept the current Terms and Privacy Policy. `version` must be the one the user was shown.
  router.post('/accept-terms', (req, res) => {
    const user = requireSession(req);
    if (body(req).version !== TERMS_VERSION) throw new HttpError(409, 'The Terms changed since this page loaded. Reload and review them again.');
    res.json({ user: accountView(deps, auth.acceptTerms(user.id, TERMS_VERSION)) });
  });

  // Delete the account. Needs the password. Also removes the player's applications and any
  // organization this account is the only admin of. Riot match data isn't personal to the
  // account (it's public game data, cached for everyone), so it stays.
  router.delete('/me', async (req, res) => {
    const user = requireSession(req);
    const full = auth.findByEmail(user.email);
    const password = typeof body(req).password === 'string' ? (body(req).password as string) : '';
    if (!full || !(await verifyPassword(password, full.passwordHash))) throw new HttpError(401, 'That password is incorrect.');
    deps.store.db.transaction(() => {
      for (const org of auth.adminOrgs(user.id)) if (org.onlyAdmin) deps.orgs.deleteOrganization(org.id);
      if (user.playerPuuid) {
        deps.store.db.prepare('DELETE FROM applications WHERE player_puuid = ?').run(user.playerPuuid);
        deps.teams.removeAll(user.playerPuuid); // self-reported teams are theirs; Veridium roster history stays with the orgs
      }
      auth.deleteUser(user.id);
    })();
    clearSessionCookie(req, res);
    res.status(204).end();
  });

  // "Looking for team" for the account's player: { lookingForTeam: boolean, roles?: "Flex, Sub" }.
  router.put('/me/lft', (req, res) => {
    const user = requireUser(req);
    if (!user.playerPuuid) throw new HttpError(403, 'Link your Riot ID first, so orgs can see who is looking.');
    const b = body(req);
    if (typeof b.lookingForTeam !== 'boolean') throw badRequest('"lookingForTeam" must be true or false');
    const roles = str(b, 'roles').slice(0, 60) || null;
    res.json({ user: accountView(deps, auth.setLookingForTeam(user.id, b.lookingForTeam, roles)) });
  });

  // Email copies of notifications: { enabled: boolean }.
  router.put('/me/email-notifications', (req, res) => {
    const user = requireUser(req);
    const enabled = body(req).enabled;
    if (typeof enabled !== 'boolean') throw badRequest('"enabled" must be true or false');
    res.json({ user: accountView(deps, auth.setEmailNotifications(user.id, enabled)) });
  });

  // Link a Riot ID to the account, or unlink with { riotId: null }.
  router.put('/me/player', async (req, res) => {
    const user = requireUser(req);
    const b = body(req);
    const riotId = str(b, 'riotId');
    const puuid = riotId ? await resolveRiotId(deps, riotId, str(b, 'region') || 'na1') : null;
    res.json({ user: accountView(deps, auth.linkPlayer(user.id, puuid)) });
  });

  router.use(errorHandler);
  return router;
}

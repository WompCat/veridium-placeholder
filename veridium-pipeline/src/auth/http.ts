import type { Request, RequestHandler, Response } from 'express';
import { TERMS_VERSION } from '../legal';
import { forbidden, HttpError, unauthorized } from '../orgs/errors';
import { SESSION_DAYS, type AuthRepo, type User } from './repo';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      /** The logged-in account, set by `sessions()`; null when logged out. */
      user?: User | null;
    }
  }
}

export const SESSION_COOKIE = 'veridium_session';

function readCookie(req: Request, name: string): string | null {
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const eq = part.indexOf('=');
    if (eq !== -1 && part.slice(0, eq).trim() === name) return decodeURIComponent(part.slice(eq + 1).trim());
  }
  return null;
}

/** Resolves the session cookie to `req.user` on every request. */
export function sessions(auth: AuthRepo): RequestHandler {
  return (req, _res, next) => {
    const token = readCookie(req, SESSION_COOKIE);
    req.user = token ? auth.userForSession(token) : null;
    next();
  };
}

export const sessionToken = (req: Request) => readCookie(req, SESSION_COOKIE);

// HttpOnly: page scripts can't read it. SameSite=Lax: other sites can't send it with their POSTs.
// Secure whenever the request came over HTTPS (Render terminates TLS in front of the app).
export function setSessionCookie(req: Request, res: Response, token: string) {
  res.cookie(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: req.secure,
    path: '/',
    maxAge: SESSION_DAYS * 86_400_000,
  });
}

export function clearSessionCookie(req: Request, res: Response) {
  res.clearCookie(SESSION_COOKIE, { httpOnly: true, sameSite: 'lax', secure: req.secure, path: '/' });
}

/** Logged in, whatever Terms version was accepted: for accepting the Terms, logging out, deleting the account. */
export function requireSession(req: Request): User {
  if (!req.user) throw unauthorized();
  return req.user;
}

/** Logged in and on the current Terms of Service / Privacy Policy. Everything else that needs a login uses this. */
export function requireUser(req: Request): User {
  const user = requireSession(req);
  if (user.termsVersion !== TERMS_VERSION) {
    throw new HttpError(403, 'Please review and accept the updated Terms of Service and Privacy Policy to continue.', 'terms_required');
  }
  return user;
}

/** The logged-in account's linked player: what applications are made as. */
export function requireLinkedPlayer(req: Request): string {
  const user = requireUser(req);
  if (!user.playerPuuid) throw forbidden('Link your Riot ID to your account first (Account settings).');
  return user.playerPuuid;
}

/** A Veridium staff account (listed in ADMIN_EMAILS), e.g. to verify organizations. */
export function isSiteAdmin(user: User | null | undefined, adminEmails: string[]): boolean {
  return !!user && adminEmails.includes(user.email.toLowerCase());
}

export function requireOrgAdmin(auth: AuthRepo, req: Request, orgId: string): User {
  const user = requireUser(req);
  if (!auth.isOrgAdmin(orgId, user.id)) throw forbidden("Only this organization's admins can do that.");
  return user;
}

import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { conflict } from '../orgs/errors';

export interface User {
  id: string;
  email: string;
  playerPuuid: string | null;
  createdAt: string;
  /** The Terms/Privacy version this account accepted (null: never). */
  termsVersion: string | null;
  termsAcceptedAt: string | null;
}

interface UserRow {
  id: string;
  email: string;
  password_hash: string;
  player_puuid: string | null;
  created_at: string;
  terms_version: string | null;
  terms_accepted_at: string | null;
}

const toUser = (r: UserRow): User => ({
  id: r.id,
  email: r.email,
  playerPuuid: r.player_puuid,
  createdAt: r.created_at,
  termsVersion: r.terms_version,
  termsAcceptedAt: r.terms_accepted_at,
});

export const SESSION_DAYS = 30;
const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');

/** Users, sessions and org admins. */
export class AuthRepo {
  constructor(
    private db: Database.Database,
    private now: () => Date = () => new Date(),
  ) {}

  // ---- Users ----

  /** `termsVersion`: the Terms/Privacy version accepted at sign-up. */
  createUser(email: string, passwordHash: string, playerPuuid: string | null, termsVersion: string | null): User {
    if (this.findByEmail(email)) throw conflict('An account with that email already exists. Log in instead.');
    if (playerPuuid) this.assertPlayerFree(playerPuuid);
    const createdAt = this.now().toISOString();
    const row: UserRow = {
      id: randomUUID(),
      email,
      password_hash: passwordHash,
      player_puuid: playerPuuid,
      created_at: createdAt,
      terms_version: termsVersion,
      terms_accepted_at: termsVersion ? createdAt : null,
    };
    try {
      this.db
        .prepare(
          `INSERT INTO users (id, email, password_hash, player_puuid, created_at, terms_version, terms_accepted_at)
           VALUES (@id, @email, @password_hash, @player_puuid, @created_at, @terms_version, @terms_accepted_at)`,
        )
        .run(row);
    } catch (err) {
      // Lost a race with a simultaneous signup for the same email or Riot ID.
      if ((err as { code?: string }).code === 'SQLITE_CONSTRAINT_UNIQUE') throw conflict('That email or Riot ID is already registered.');
      throw err;
    }
    return toUser(row);
  }

  findByEmail(email: string): (User & { passwordHash: string }) | null {
    const row = this.db.prepare('SELECT * FROM users WHERE email = ?').get(email) as UserRow | undefined;
    return row ? { ...toUser(row), passwordHash: row.password_hash } : null;
  }

  getUser(id: string): User | null {
    const row = this.db.prepare('SELECT * FROM users WHERE id = ?').get(id) as UserRow | undefined;
    return row ? toUser(row) : null;
  }

  /** Link (or with null, unlink) the account's Riot ID. A player belongs to one account at most. */
  linkPlayer(userId: string, playerPuuid: string | null): User {
    if (playerPuuid) this.assertPlayerFree(playerPuuid, userId);
    this.db.prepare('UPDATE users SET player_puuid = ? WHERE id = ?').run(playerPuuid, userId);
    return this.getUser(userId)!;
  }

  acceptTerms(userId: string, version: string): User {
    this.db.prepare('UPDATE users SET terms_version = ?, terms_accepted_at = ? WHERE id = ?').run(version, this.now().toISOString(), userId);
    return this.getUser(userId)!;
  }

  /** Deletes the account; its sessions and admin roles go with it (ON DELETE CASCADE). */
  deleteUser(userId: string): void {
    this.db.prepare('DELETE FROM users WHERE id = ?').run(userId);
  }

  private assertPlayerFree(puuid: string, exceptUserId?: string) {
    const owner = this.db.prepare('SELECT id FROM users WHERE player_puuid = ?').get(puuid) as { id: string } | undefined;
    if (owner && owner.id !== exceptUserId) throw conflict('That Riot ID is already linked to another Veridium account.');
  }

  // ---- Sessions: the cookie holds a random token; the db holds its hash ----

  createSession(userId: string): { token: string; expiresAt: Date } {
    const token = randomBytes(32).toString('base64url');
    const now = this.now();
    const expiresAt = new Date(now.getTime() + SESSION_DAYS * 86_400_000);
    this.db
      .prepare('INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)')
      .run(hashToken(token), userId, now.toISOString(), expiresAt.toISOString());
    return { token, expiresAt };
  }

  userForSession(token: string): User | null {
    const row = this.db
      .prepare(
        `SELECT u.*, s.expires_at FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?`,
      )
      .get(hashToken(token)) as (UserRow & { expires_at: string }) | undefined;
    if (!row) return null;
    if (row.expires_at <= this.now().toISOString()) {
      this.deleteSession(token);
      return null;
    }
    return toUser(row);
  }

  deleteSession(token: string): void {
    this.db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(hashToken(token));
  }

  // ---- Org admins ----

  isOrgAdmin(orgId: string, userId: string): boolean {
    return !!this.db.prepare('SELECT 1 FROM org_admins WHERE organization_id = ? AND user_id = ?').get(orgId, userId);
  }

  orgHasAdmins(orgId: string): boolean {
    return !!this.db.prepare('SELECT 1 FROM org_admins WHERE organization_id = ?').get(orgId);
  }

  addOrgAdmin(orgId: string, userId: string): void {
    this.db
      .prepare('INSERT OR IGNORE INTO org_admins (organization_id, user_id, created_at) VALUES (?, ?, ?)')
      .run(orgId, userId, this.now().toISOString());
  }

  /** Orgs this account manages; `onlyAdmin` when nobody else does (deleting the account deletes those). */
  adminOrgs(userId: string): Array<{ id: string; name: string; onlyAdmin: boolean }> {
    const rows = this.db
      .prepare(
        `SELECT o.id, o.name,
                (SELECT COUNT(*) FROM org_admins x WHERE x.organization_id = o.id) AS admins
         FROM org_admins a JOIN organizations o ON o.id = a.organization_id
         WHERE a.user_id = ? ORDER BY o.name`,
      )
      .all(userId) as Array<{ id: string; name: string; admins: number }>;
    return rows.map((r) => ({ id: r.id, name: r.name, onlyAdmin: r.admins === 1 }));
  }
}

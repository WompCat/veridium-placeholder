import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { conflict } from '../orgs/errors';

export interface User {
  id: string;
  email: string;
  playerPuuid: string | null;
  createdAt: string;
}

interface UserRow {
  id: string;
  email: string;
  password_hash: string;
  player_puuid: string | null;
  created_at: string;
}

const toUser = (r: UserRow): User => ({ id: r.id, email: r.email, playerPuuid: r.player_puuid, createdAt: r.created_at });

export const SESSION_DAYS = 30;
const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');

/** Users, sessions and org admins. */
export class AuthRepo {
  constructor(
    private db: Database.Database,
    private now: () => Date = () => new Date(),
  ) {}

  // ---- Users ----

  createUser(email: string, passwordHash: string, playerPuuid: string | null): User {
    if (this.findByEmail(email)) throw conflict('An account with that email already exists. Log in instead.');
    if (playerPuuid) this.assertPlayerFree(playerPuuid);
    const row: UserRow = {
      id: randomUUID(),
      email,
      password_hash: passwordHash,
      player_puuid: playerPuuid,
      created_at: this.now().toISOString(),
    };
    try {
      this.db
        .prepare('INSERT INTO users (id, email, password_hash, player_puuid, created_at) VALUES (@id, @email, @password_hash, @player_puuid, @created_at)')
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

  adminOrgs(userId: string): Array<{ id: string; name: string }> {
    return this.db
      .prepare(
        `SELECT o.id, o.name FROM org_admins a JOIN organizations o ON o.id = a.organization_id
         WHERE a.user_id = ? ORDER BY o.name`,
      )
      .all(userId) as Array<{ id: string; name: string }>;
  }
}

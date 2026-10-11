import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';

export interface Notification {
  id: string;
  type: string;
  text: string;
  link: string;
  createdAt: string;
  read: boolean;
}

interface Row {
  id: string;
  type: string;
  text: string;
  link: string;
  created_at: string;
  read_at: string | null;
}

const KEEP = 100; // per account; older ones are pruned

/** Creates notifications for the right accounts when something happens, and serves them back. */
export class Notifier {
  constructor(
    private db: Database.Database,
    private now: () => Date = () => new Date(),
  ) {}

  private add(userIds: string[], type: string, text: string, link: string) {
    const insert = this.db.prepare(
      'INSERT INTO notifications (id, user_id, type, text, link, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    );
    const prune = this.db.prepare(
      `DELETE FROM notifications WHERE user_id = ? AND id NOT IN
         (SELECT id FROM notifications WHERE user_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ${KEEP})`,
    );
    const at = this.now().toISOString();
    for (const userId of new Set(userIds)) {
      insert.run(randomUUID(), userId, type, text, link, at);
      prune.run(userId, userId);
    }
  }

  private orgAdmins(orgId: string): string[] {
    return (this.db.prepare('SELECT user_id FROM org_admins WHERE organization_id = ?').all(orgId) as Array<{ user_id: string }>)
      .map((r) => r.user_id);
  }

  /** The account linked to a player, if they have one. */
  private playerAccount(puuid: string): string[] {
    const row = this.db.prepare('SELECT id FROM users WHERE player_puuid = ?').get(puuid) as { id: string } | undefined;
    return row ? [row.id] : [];
  }

  private playerLink(puuid: string, hash: string): string {
    const p = this.db.prepare('SELECT game_name, tag_line, region FROM players WHERE puuid = ?').get(puuid) as
      | { game_name: string; tag_line: string; region: string }
      | undefined;
    if (!p) return 'login.html';
    return `player.html?riotId=${encodeURIComponent(`${p.game_name}#${p.tag_line}`)}&region=${encodeURIComponent(p.region)}${hash}`;
  }

  private names(puuid: string, orgId: string) {
    const player = this.db.prepare('SELECT game_name FROM players WHERE puuid = ?').get(puuid) as { game_name: string } | undefined;
    const org = this.db.prepare('SELECT name FROM organizations WHERE id = ?').get(orgId) as { name: string } | undefined;
    return { player: player?.game_name ?? 'A player', org: org?.name ?? 'An organization' };
  }

  // ---- Events ----

  applicationReceived(orgId: string, vacancyTitle: string, puuid: string) {
    const n = this.names(puuid, orgId);
    this.add(this.orgAdmins(orgId), 'application.received', `${n.player} applied to ${vacancyTitle}.`,
      `org.html?id=${encodeURIComponent(orgId)}#vacancies`);
  }

  applicationDecided(orgId: string, vacancyTitle: string, puuid: string, decision: 'accepted' | 'rejected', rostered: boolean) {
    const n = this.names(puuid, orgId);
    const text = decision === 'accepted'
      ? `${n.org} accepted your application for ${vacancyTitle}${rostered ? ' and added you to the roster' : ''}.`
      : `${n.org} didn't select you for ${vacancyTitle} this time.`;
    this.add(this.playerAccount(puuid), `application.${decision}`, text, this.playerLink(puuid, '#applications'));
  }

  rosterAdded(orgId: string, puuid: string, role: string) {
    const n = this.names(puuid, orgId);
    this.add(this.playerAccount(puuid), 'roster.added', `${n.org} added you to its roster as ${role}.`,
      `org.html?id=${encodeURIComponent(orgId)}#roster`);
  }

  rosterRemoved(orgId: string, puuid: string) {
    const n = this.names(puuid, orgId);
    this.add(this.playerAccount(puuid), 'roster.removed', `${n.org} removed you from its roster.`,
      `org.html?id=${encodeURIComponent(orgId)}`);
  }

  // ---- Reading ----

  list(userId: string, limit = 20): { unread: number; items: Notification[] } {
    const rows = this.db
      .prepare('SELECT * FROM notifications WHERE user_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?')
      .all(userId, limit) as Row[];
    const { unread } = this.db
      .prepare('SELECT COUNT(*) AS unread FROM notifications WHERE user_id = ? AND read_at IS NULL')
      .get(userId) as { unread: number };
    return {
      unread,
      items: rows.map((r) => ({ id: r.id, type: r.type, text: r.text, link: r.link, createdAt: r.created_at, read: !!r.read_at })),
    };
  }

  /** Marks the given notifications (or all of them) as read, for this account only. */
  markRead(userId: string, ids?: string[]) {
    const at = this.now().toISOString();
    if (!ids) {
      this.db.prepare('UPDATE notifications SET read_at = ? WHERE user_id = ? AND read_at IS NULL').run(at, userId);
      return;
    }
    const update = this.db.prepare('UPDATE notifications SET read_at = ? WHERE user_id = ? AND id = ? AND read_at IS NULL');
    for (const id of ids) update.run(at, userId, id);
  }
}

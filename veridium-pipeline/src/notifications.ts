import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { Mailer } from './email';

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

/**
 * Creates notifications for the right accounts when something happens, and serves them back.
 * With a mailer, each one is also emailed to accounts that haven't turned email notifications off.
 */
export class Notifier {
  private sending = new Set<Promise<void>>();

  constructor(
    private db: Database.Database,
    private mailer: Mailer | null = null,
    private now: () => Date = () => new Date(),
  ) {}

  /** Whether notification emails can be sent at all (an email service is configured). */
  get emailEnabled(): boolean {
    return !!this.mailer;
  }

  /** Resolves once every email started so far has been sent or has failed. */
  async idle(): Promise<void> {
    await Promise.all([...this.sending]);
  }

  // Emails go out in the background: a slow or failing email service never fails the request.
  private email(userIds: string[], text: string, link: string) {
    if (!this.mailer || !userIds.length) return;
    const rows = this.db
      .prepare(`SELECT email FROM users WHERE email_notifications = 1 AND id IN (${userIds.map(() => '?').join(',')})`)
      .all(...userIds) as Array<{ email: string }>;
    const subject = `Veridium: ${text.length > 90 ? text.slice(0, 89) + '…' : text}`;
    for (const { email } of rows) {
      const p = this.mailer.send({ to: email, subject, text, link })
        .catch((err) => console.error(`notification email failed: ${(err as Error).message}`))
        .finally(() => this.sending.delete(p));
      this.sending.add(p);
    }
  }

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
    this.email([...new Set(userIds)], text, link);
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

  orgVerified(orgId: string) {
    const org = this.db.prepare('SELECT name FROM organizations WHERE id = ?').get(orgId) as { name: string } | undefined;
    this.add(this.orgAdmins(orgId), 'org.verified', `Veridium verified ${org?.name ?? 'your organization'}. The badge now shows on your page and vacancies.`,
      `org.html?id=${encodeURIComponent(orgId)}`);
  }

  /** Tells Veridium staff (accounts whose email is in ADMIN_EMAILS) about a new organizer application. */
  organizerApplied(adminEmails: string[], name: string) {
    if (!adminEmails.length) return;
    const ids = (this.db
      .prepare(`SELECT id FROM users WHERE lower(email) IN (${adminEmails.map(() => '?').join(',')})`)
      .all(...adminEmails) as Array<{ id: string }>).map((r) => r.id);
    this.add(ids, 'organizer.applied', `${name} applied to be a tournament organizer.`, 'admin.html');
  }

  organizerDecided(userId: string, name: string, status: 'approved' | 'rejected') {
    this.add([userId], `organizer.${status}`, status === 'approved'
      ? `Veridium approved ${name} as a tournament organizer. You can now post results.`
      : `Veridium didn't approve ${name} as a tournament organizer.`, 'organizer.html');
  }

  tournamentResult(puuid: string, tournament: string, placement: number, organizer: string) {
    const ord = (n: number) => n + (n % 100 >= 11 && n % 100 <= 13 ? 'th' : ({ 1: 'st', 2: 'nd', 3: 'rd' } as Record<number, string>)[n % 10] ?? 'th');
    this.add(this.playerAccount(puuid), 'tournament.result', `${organizer} recorded your ${ord(placement)} place at ${tournament}.`,
      this.playerLink(puuid, '#tournaments'));
  }

  resultReported(organizerUserId: string, puuid: string, tournament: string) {
    const player = this.db.prepare('SELECT game_name FROM players WHERE puuid = ?').get(puuid) as { game_name: string } | undefined;
    this.add([organizerUserId], 'tournament.reported', `${player?.game_name ?? 'A player'} said a result at ${tournament} isn't theirs. It's hidden from their profile; check and fix it.`,
      'organizer.html');
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

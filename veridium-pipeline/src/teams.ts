import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { badRequest, conflict, notFound } from './orgs/errors';

export interface SelfReportedTeam {
  id: string;
  team: string;
  role: string | null;
  game: string | null;
  started: string; // YYYY-MM
  ended: string | null; // null: present
}

/** A stint on a Veridium org's roster: verified by the org, not by the player. */
export interface VeridiumTeam {
  organizationId: string;
  organizationName: string;
  organizationVerified: boolean;
  role: string;
  joinedAt: string;
  leftAt: string | null;
}

const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;
export const MAX_TEAMS = 20;

export class TeamHistoryRepo {
  constructor(
    private db: Database.Database,
    private now: () => Date = () => new Date(),
  ) {}

  /** Both tiers for a player: roster stints on Veridium (verified by the org) and self-reported teams. */
  forPlayer(puuid: string): { veridium: VeridiumTeam[]; selfReported: SelfReportedTeam[] } {
    const veridium = this.db
      .prepare(
        `SELECT m.organization_id, o.name, o.verified_at, m.role, m.joined_at, m.left_at
         FROM org_memberships m JOIN organizations o ON o.id = m.organization_id
         WHERE m.player_puuid = ? ORDER BY m.joined_at DESC, m.rowid DESC`,
      )
      .all(puuid) as Array<{ organization_id: string; name: string; verified_at: string | null; role: string; joined_at: string; left_at: string | null }>;
    const self = this.db
      .prepare(
        `SELECT id, team, role, game, started, ended FROM team_history WHERE player_puuid = ?
         ORDER BY (ended IS NULL) DESC, COALESCE(ended, started) DESC, started DESC`,
      )
      .all(puuid) as SelfReportedTeam[];
    return {
      veridium: veridium.map((r) => ({
        organizationId: r.organization_id,
        organizationName: r.name,
        organizationVerified: !!r.verified_at,
        role: r.role,
        joinedAt: r.joined_at,
        leftAt: r.left_at,
      })),
      selfReported: self,
    };
  }

  add(puuid: string, t: { team: string; role?: string | null; game?: string | null; started: string; ended?: string | null }): SelfReportedTeam {
    if (!MONTH.test(t.started)) throw badRequest('"started" must be a month like 2025-03');
    if (t.ended && !MONTH.test(t.ended)) throw badRequest('"ended" must be a month like 2025-09, or empty for present');
    if (t.ended && t.ended < t.started) throw badRequest('A team can’t end before it started');
    const thisMonth = this.now().toISOString().slice(0, 7);
    if (t.started > thisMonth || (t.ended && t.ended > thisMonth)) throw badRequest('Dates can’t be in the future');
    const count = (this.db.prepare('SELECT COUNT(*) AS n FROM team_history WHERE player_puuid = ?').get(puuid) as { n: number }).n;
    if (count >= MAX_TEAMS) throw conflict(`You can list up to ${MAX_TEAMS} teams`);
    const row: SelfReportedTeam = { id: randomUUID(), team: t.team, role: t.role ?? null, game: t.game ?? null, started: t.started, ended: t.ended ?? null };
    this.db
      .prepare('INSERT INTO team_history (id, player_puuid, team, role, game, started, ended, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(row.id, puuid, row.team, row.role, row.game, row.started, row.ended, this.now().toISOString());
    return row;
  }

  /** Removes one of this player's own entries. */
  remove(puuid: string, id: string) {
    const r = this.db.prepare('DELETE FROM team_history WHERE id = ? AND player_puuid = ?').run(id, puuid);
    if (!r.changes) throw notFound('Team entry not found');
  }

  removeAll(puuid: string) {
    this.db.prepare('DELETE FROM team_history WHERE player_puuid = ?').run(puuid);
  }
}

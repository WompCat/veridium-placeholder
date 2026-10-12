import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { badRequest, conflict, notFound } from '../orgs/errors';

export type OrganizerStatus = 'pending' | 'approved' | 'rejected';

export interface Organizer {
  id: string;
  userId: string;
  name: string;
  website: string | null;
  description: string | null;
  status: OrganizerStatus;
  createdAt: string;
  decidedAt: string | null;
}

export interface Tournament {
  id: string;
  organizerId: string;
  organizerName: string;
  name: string;
  game: string;
  date: string;
  region: string | null;
  url: string | null;
  resultCount: number;
}

export interface TournamentResult {
  id: string;
  tournamentId: string;
  playerPuuid: string;
  placement: number;
  team: string | null;
}

interface OrganizerRow {
  id: string; user_id: string; name: string; website: string | null; description: string | null;
  status: OrganizerStatus; created_at: string; decided_at: string | null;
}
const toOrganizer = (r: OrganizerRow): Organizer => ({
  id: r.id, userId: r.user_id, name: r.name, website: r.website, description: r.description,
  status: r.status, createdAt: r.created_at, decidedAt: r.decided_at,
});

const DATE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;

/** Organizers, their tournaments and results. Public reads only ever include approved organizers. */
export class TournamentRepo {
  constructor(
    private db: Database.Database,
    private now: () => Date = () => new Date(),
  ) {}

  // ---- Organizers ----

  apply(userId: string, o: { name: string; website: string | null; description: string | null }): Organizer {
    if (this.organizerForUser(userId)) throw conflict('This account already has an organizer profile.');
    const row: OrganizerRow = {
      id: randomUUID(), user_id: userId, name: o.name, website: o.website, description: o.description,
      status: 'pending', created_at: this.now().toISOString(), decided_at: null,
    };
    this.db
      .prepare(`INSERT INTO organizers (id, user_id, name, website, description, status, created_at)
                VALUES (@id, @user_id, @name, @website, @description, @status, @created_at)`)
      .run(row);
    return toOrganizer(row);
  }

  organizerForUser(userId: string): Organizer | null {
    const r = this.db.prepare('SELECT * FROM organizers WHERE user_id = ?').get(userId) as OrganizerRow | undefined;
    return r ? toOrganizer(r) : null;
  }

  getOrganizer(id: string): Organizer | null {
    const r = this.db.prepare('SELECT * FROM organizers WHERE id = ?').get(id) as OrganizerRow | undefined;
    return r ? toOrganizer(r) : null;
  }

  listOrganizers(status?: OrganizerStatus): Organizer[] {
    const rows = (status
      ? this.db.prepare('SELECT * FROM organizers WHERE status = ? ORDER BY created_at DESC').all(status)
      : this.db.prepare('SELECT * FROM organizers ORDER BY created_at DESC').all()) as OrganizerRow[];
    return rows.map(toOrganizer);
  }

  decide(id: string, status: 'approved' | 'rejected'): Organizer {
    if (!this.getOrganizer(id)) throw notFound('Organizer not found');
    this.db.prepare('UPDATE organizers SET status = ?, decided_at = ? WHERE id = ?').run(status, this.now().toISOString(), id);
    return this.getOrganizer(id)!;
  }

  // ---- Tournaments ----

  createTournament(organizerId: string, t: { name: string; game: string; date: string; region: string | null; url: string | null }): Tournament {
    if (!DATE.test(t.date)) throw badRequest('"date" must be a day like 2026-09-27');
    if (t.date > this.now().toISOString().slice(0, 10)) throw badRequest('Only record tournaments that have finished.');
    const id = randomUUID();
    this.db
      .prepare('INSERT INTO tournaments (id, organizer_id, name, game, date, region, url, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id, organizerId, t.name, t.game, t.date, t.region, t.url, this.now().toISOString());
    return this.getTournament(id)!;
  }

  private tournamentQuery(where: string) {
    return `SELECT t.*, o.name AS organizer_name, o.status AS organizer_status,
              (SELECT COUNT(*) FROM tournament_results r WHERE r.tournament_id = t.id AND r.hidden = 0) AS result_count
            FROM tournaments t JOIN organizers o ON o.id = t.organizer_id ${where}`;
  }

  private toTournament(r: Record<string, unknown>): Tournament {
    return {
      id: r.id as string, organizerId: r.organizer_id as string, organizerName: r.organizer_name as string,
      name: r.name as string, game: r.game as string, date: r.date as string,
      region: (r.region as string) ?? null, url: (r.url as string) ?? null, resultCount: r.result_count as number,
    };
  }

  getTournament(id: string, { publicOnly = false } = {}): Tournament | null {
    const r = this.db.prepare(this.tournamentQuery(`WHERE t.id = ?${publicOnly ? " AND o.status = 'approved'" : ''}`)).get(id) as Record<string, unknown> | undefined;
    return r ? this.toTournament(r) : null;
  }

  /** Approved organizers' tournaments (or one organizer's own, any status), newest first. */
  listTournaments(opts: { organizerId?: string } = {}): Tournament[] {
    const rows = (opts.organizerId
      ? this.db.prepare(this.tournamentQuery('WHERE t.organizer_id = ? ORDER BY t.date DESC, t.rowid DESC')).all(opts.organizerId)
      : this.db.prepare(this.tournamentQuery("WHERE o.status = 'approved' ORDER BY t.date DESC, t.rowid DESC LIMIT 100")).all()) as Array<Record<string, unknown>>;
    return rows.map((r) => this.toTournament(r));
  }

  deleteTournament(id: string) {
    this.db.prepare('DELETE FROM tournaments WHERE id = ?').run(id);
  }

  // ---- Results ----

  addResult(tournamentId: string, puuid: string, placement: number, team: string | null): TournamentResult {
    if (!Number.isInteger(placement) || placement < 1 || placement > 10000) throw badRequest('"placement" must be a whole number from 1');
    const id = randomUUID();
    const inserted = this.db
      .prepare(`INSERT OR IGNORE INTO tournament_results (id, tournament_id, player_puuid, placement, team, created_at)
                VALUES (?, ?, ?, ?, ?, ?)`)
      .run(id, tournamentId, puuid, placement, team, this.now().toISOString());
    if (!inserted.changes) throw conflict('That player already has a result in this tournament. Remove it first to change it.');
    return { id, tournamentId, playerPuuid: puuid, placement, team };
  }

  getResult(id: string): (TournamentResult & { hidden: boolean }) | null {
    const r = this.db.prepare('SELECT * FROM tournament_results WHERE id = ?').get(id) as
      | { id: string; tournament_id: string; player_puuid: string; placement: number; team: string | null; hidden: number }
      | undefined;
    return r ? { id: r.id, tournamentId: r.tournament_id, playerPuuid: r.player_puuid, placement: r.placement, team: r.team, hidden: !!r.hidden } : null;
  }

  /** A tournament's results, best placement first. Hidden ("Not me") ones only for the organizer. */
  results(tournamentId: string, { includeHidden = false } = {}): Array<TournamentResult & { hidden: boolean }> {
    const rows = this.db
      .prepare(`SELECT * FROM tournament_results WHERE tournament_id = ? ${includeHidden ? '' : 'AND hidden = 0'} ORDER BY placement, rowid`)
      .all(tournamentId) as Array<{ id: string; tournament_id: string; player_puuid: string; placement: number; team: string | null; hidden: number }>;
    return rows.map((r) => ({ id: r.id, tournamentId: r.tournament_id, playerPuuid: r.player_puuid, placement: r.placement, team: r.team, hidden: !!r.hidden }));
  }

  deleteResult(id: string) {
    this.db.prepare('DELETE FROM tournament_results WHERE id = ?').run(id);
  }

  hideResult(id: string) {
    this.db.prepare('UPDATE tournament_results SET hidden = 1 WHERE id = ?').run(id);
  }

  /** A player's visible results from approved organizers, newest tournament first. */
  playerResults(puuid: string): Array<{ resultId: string; placement: number; team: string | null; tournament: Tournament }> {
    const rows = this.db
      .prepare(this.tournamentQuery(`JOIN tournament_results r2 ON r2.tournament_id = t.id
         WHERE r2.player_puuid = ? AND r2.hidden = 0 AND o.status = 'approved' ORDER BY t.date DESC`)
        .replace('SELECT t.*,', 'SELECT t.*, r2.id AS result_id, r2.placement AS placement, r2.team AS team_name,'))
      .all(puuid) as Array<Record<string, unknown>>;
    return rows.map((r) => ({ resultId: r.result_id as string, placement: r.placement as number, team: (r.team_name as string) ?? null, tournament: this.toTournament(r) }));
  }
}

import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import type {
  Application,
  ApplicationStatus,
  MembershipStatus,
  OrgMembership,
  Organization,
  Vacancy,
  VacancyLevel,
  VacancyStatus,
} from '../types';
import { conflict, notFound } from './errors';

interface MembershipRow {
  player_puuid: string;
  organization_id: string;
  role: string;
  status: MembershipStatus;
  joined_at: string;
  left_at: string | null;
}

interface VacancyRow {
  id: string;
  organization_id: string;
  title: string;
  game: string;
  region: string;
  level: VacancyLevel;
  status: VacancyStatus;
  posted_at: string;
}

interface ApplicationRow {
  id: string;
  vacancy_id: string;
  player_puuid: string;
  status: ApplicationStatus;
  applied_at: string;
}

const toMembership = (r: MembershipRow): OrgMembership => ({
  playerPuuid: r.player_puuid,
  organizationId: r.organization_id,
  role: r.role,
  status: r.status,
  joinedAt: r.joined_at,
  leftAt: r.left_at,
});

const toVacancy = (r: VacancyRow): Vacancy => ({
  id: r.id,
  organizationId: r.organization_id,
  title: r.title,
  game: r.game,
  region: r.region,
  level: r.level,
  status: r.status,
  postedAt: r.posted_at,
});

const toApplication = (r: ApplicationRow): Application => ({
  id: r.id,
  vacancyId: r.vacancy_id,
  playerPuuid: r.player_puuid,
  status: r.status,
  appliedAt: r.applied_at,
});

export function slugify(name: string): string {
  return name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export type NewVacancy = Pick<Vacancy, 'title' | 'game' | 'region' | 'level'>;
export type VacancyPatch = Partial<Pick<Vacancy, 'title' | 'game' | 'region' | 'level' | 'status'>>;

/** Reads and writes for organizations, rosters, vacancies and applications. Player stats stay in the pipeline's tables. */
export class OrgRepo {
  constructor(
    private db: Database.Database,
    private now: () => Date = () => new Date(),
  ) {}

  private iso(): string {
    return this.now().toISOString();
  }

  private requirePlayer(puuid: string): void {
    if (!this.db.prepare('SELECT 1 FROM players WHERE puuid = ?').get(puuid)) {
      throw notFound('Player not found. Load their profile first so their verified stats are cached.');
    }
  }

  // ---- Organizations ----

  createOrganization(name: string, id = slugify(name)): Organization {
    const org = { id, name, createdAt: this.iso() };
    const inserted = this.db
      .prepare('INSERT OR IGNORE INTO organizations (id, name, created_at) VALUES (?, ?, ?)')
      .run(org.id, org.name, org.createdAt);
    if (!inserted.changes) throw conflict(`Organization "${id}" already exists`);
    return org;
  }

  getOrganization(id: string): Organization | null {
    const row = this.db.prepare('SELECT id, name, created_at FROM organizations WHERE id = ?').get(id) as
      | { id: string; name: string; created_at: string }
      | undefined;
    return row ? { id: row.id, name: row.name, createdAt: row.created_at } : null;
  }

  requireOrganization(id: string): Organization {
    const org = this.getOrganization(id);
    if (!org) throw notFound(`Organization "${id}" not found`);
    return org;
  }

  // ---- Roster ----

  /** Current members (active first, then bench), oldest joiners first. */
  listRoster(orgId: string): OrgMembership[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM org_memberships WHERE organization_id = ? AND left_at IS NULL
         ORDER BY CASE status WHEN 'active' THEN 0 ELSE 1 END, joined_at, id`,
      )
      .all(orgId) as MembershipRow[];
    return rows.map(toMembership);
  }

  getMembership(orgId: string, puuid: string): OrgMembership | null {
    const row = this.db
      .prepare('SELECT * FROM org_memberships WHERE organization_id = ? AND player_puuid = ? AND left_at IS NULL')
      .get(orgId, puuid) as MembershipRow | undefined;
    return row ? toMembership(row) : null;
  }

  addMember(orgId: string, puuid: string, role: string, status: MembershipStatus): OrgMembership {
    this.requireOrganization(orgId);
    this.requirePlayer(puuid);
    if (this.getMembership(orgId, puuid)) throw conflict('Player is already on this roster');
    const joinedAt = this.iso();
    this.db
      .prepare(
        `INSERT INTO org_memberships (player_puuid, organization_id, role, status, joined_at) VALUES (?, ?, ?, ?, ?)`,
      )
      .run(puuid, orgId, role, status, joinedAt);
    return { playerPuuid: puuid, organizationId: orgId, role, status, joinedAt, leftAt: null };
  }

  updateMember(orgId: string, puuid: string, patch: { role?: string; status?: MembershipStatus }): OrgMembership {
    const current = this.getMembership(orgId, puuid);
    if (!current) throw notFound('Player is not on this roster');
    const next = { ...current, ...patch };
    this.db
      .prepare(
        `UPDATE org_memberships SET role = ?, status = ?
         WHERE organization_id = ? AND player_puuid = ? AND left_at IS NULL`,
      )
      .run(next.role, next.status, orgId, puuid);
    return next;
  }

  /** Ends the player's current stint; the row is kept as roster history. */
  removeMember(orgId: string, puuid: string): OrgMembership {
    const current = this.getMembership(orgId, puuid);
    if (!current) throw notFound('Player is not on this roster');
    const leftAt = this.iso();
    this.db
      .prepare('UPDATE org_memberships SET left_at = ? WHERE organization_id = ? AND player_puuid = ? AND left_at IS NULL')
      .run(leftAt, orgId, puuid);
    return { ...current, leftAt };
  }

  // ---- Vacancies ----

  createVacancy(orgId: string, v: NewVacancy): Vacancy {
    this.requireOrganization(orgId);
    const vacancy: Vacancy = { id: randomUUID(), organizationId: orgId, ...v, status: 'open', postedAt: this.iso() };
    this.db
      .prepare(
        `INSERT INTO vacancies (id, organization_id, title, game, region, level, status, posted_at)
         VALUES (@id, @organizationId, @title, @game, @region, @level, @status, @postedAt)`,
      )
      .run(vacancy);
    return vacancy;
  }

  getVacancy(id: string): Vacancy | null {
    const row = this.db.prepare('SELECT * FROM vacancies WHERE id = ?').get(id) as VacancyRow | undefined;
    return row ? toVacancy(row) : null;
  }

  requireVacancy(id: string): Vacancy {
    const v = this.getVacancy(id);
    if (!v) throw notFound('Vacancy not found');
    return v;
  }

  updateVacancy(id: string, patch: VacancyPatch): Vacancy {
    const next = { ...this.requireVacancy(id), ...patch };
    this.db
      .prepare(
        `UPDATE vacancies SET title = @title, game = @game, region = @region, level = @level, status = @status
         WHERE id = @id`,
      )
      .run(next);
    return next;
  }

  /** Vacancies with org name and application counts. Filters are exact, case-insensitive. */
  listVacancies(filter: { organizationId?: string; status?: VacancyStatus; game?: string; region?: string }) {
    const conditions = {
      organizationId: 'v.organization_id = @organizationId',
      status: 'v.status = @status',
      game: 'v.game = @game COLLATE NOCASE',
      region: 'v.region = @region COLLATE NOCASE',
    };
    const params = Object.fromEntries(Object.entries(filter).filter(([, value]) => value));
    const where = Object.keys(params).map((key) => conditions[key as keyof typeof conditions]);
    const rows = this.db
      .prepare(
        `SELECT v.*, o.name AS organization_name,
           (SELECT COUNT(*) FROM applications a WHERE a.vacancy_id = v.id) AS application_count,
           (SELECT COUNT(*) FROM applications a WHERE a.vacancy_id = v.id AND a.status = 'pending') AS pending_count
         FROM vacancies v JOIN organizations o ON o.id = v.organization_id
         ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
         ORDER BY v.posted_at DESC`,
      )
      .all(params) as Array<VacancyRow & { organization_name: string; application_count: number; pending_count: number }>;
    return rows.map((r) => ({
      ...toVacancy(r),
      organizationName: r.organization_name,
      applicationCount: r.application_count,
      pendingCount: r.pending_count,
    }));
  }

  // ---- Applications ----

  createApplication(vacancyId: string, puuid: string): Application {
    const vacancy = this.requireVacancy(vacancyId);
    if (vacancy.status !== 'open') throw conflict('This vacancy is closed');
    this.requirePlayer(puuid);
    if (this.getMembership(vacancy.organizationId, puuid)) throw conflict('Player is already on this roster');
    const app: Application = {
      id: randomUUID(),
      vacancyId,
      playerPuuid: puuid,
      status: 'pending',
      appliedAt: this.iso(),
    };
    const inserted = this.db
      .prepare(
        `INSERT OR IGNORE INTO applications (id, vacancy_id, player_puuid, status, applied_at)
         VALUES (@id, @vacancyId, @playerPuuid, @status, @appliedAt)`,
      )
      .run(app);
    if (!inserted.changes) throw conflict('Player has already applied to this vacancy');
    return app;
  }

  getApplication(id: string): Application | null {
    const row = this.db.prepare('SELECT * FROM applications WHERE id = ?').get(id) as ApplicationRow | undefined;
    return row ? toApplication(row) : null;
  }

  /** Pending first, then newest. */
  listApplications(vacancyId: string): Application[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM applications WHERE vacancy_id = ?
         ORDER BY CASE status WHEN 'pending' THEN 0 ELSE 1 END, applied_at DESC`,
      )
      .all(vacancyId) as ApplicationRow[];
    return rows.map(toApplication);
  }

  /**
   * Accept or reject a pending application. Accepting adds the player to the org's roster in
   * the same transaction, so the roster and the application history can't disagree.
   */
  decideApplication(
    id: string,
    decision: 'accepted' | 'rejected',
    roster: { role?: string; status?: MembershipStatus } = {},
  ): { application: Application; membership: OrgMembership | null } {
    return this.db.transaction(() => {
      const application = this.getApplication(id);
      if (!application) throw notFound('Application not found');
      if (application.status !== 'pending') throw conflict(`Application was already ${application.status}`);
      const vacancy = this.requireVacancy(application.vacancyId);

      this.db.prepare('UPDATE applications SET status = ? WHERE id = ?').run(decision, id);
      const membership =
        decision === 'accepted'
          ? this.addMember(
              vacancy.organizationId,
              application.playerPuuid,
              roster.role ?? vacancy.title,
              roster.status ?? 'active',
            )
          : null;
      return { application: { ...application, status: decision }, membership };
    })();
  }
}

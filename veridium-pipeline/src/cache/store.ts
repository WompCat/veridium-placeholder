import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import type { Matchup, QueueType, RankSnapshot, TftMatchDto } from '../types';

// Numbered .sql files, applied in order once each and recorded in schema_migrations.
const MIGRATIONS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'migrations');

export interface StoredPlayer {
  puuid: string;
  gameName: string;
  tagLine: string;
  region: string;
  lastMatchAt: number | null;
}

export class Store {
  readonly db: Database.Database;

  constructor(dbPath: string) {
    if (dbPath !== ':memory:') fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.runMigrations();
    this.patchPreSeasonColumns();
  }

  /** Apply any migrations/NNN_*.sql not yet recorded, each in its own transaction. */
  private runMigrations(): void {
    this.db.exec(
      'CREATE TABLE IF NOT EXISTS schema_migrations (version TEXT PRIMARY KEY, applied_at TEXT NOT NULL)',
    );
    const applied = new Set(
      (this.db.prepare('SELECT version FROM schema_migrations').all() as Array<{ version: string }>).map((r) => r.version),
    );
    const files = fs
      .readdirSync(MIGRATIONS_DIR)
      .filter((f) => /^\d+_.+\.sql$/.test(f))
      .sort();
    for (const file of files) {
      if (applied.has(file)) continue;
      const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
      this.db.transaction(() => {
        this.db.exec(sql);
        this.db.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)').run(file, new Date().toISOString());
      })();
    }
  }

  /** Databases from before seasons were tracked lack these columns (001 can't add them to existing tables). */
  private patchPreSeasonColumns(): void {
    const hasColumn = (table: string, column: string) =>
      (this.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).some((c) => c.name === column);
    if (!hasColumn('matches', 'set_number')) {
      this.db.exec(`ALTER TABLE matches ADD COLUMN set_number INTEGER`);
      this.db.exec(`UPDATE matches SET set_number = json_extract(raw_json, '$.info.tft_set_number')`);
    }
    if (!hasColumn('players', 'history_set')) this.db.exec(`ALTER TABLE players ADD COLUMN history_set INTEGER`);
  }

  upsertPlayer(p: StoredPlayer): void {
    this.db
      .prepare(
        `INSERT INTO players (puuid, game_name, tag_line, region, last_match_at, updated_at)
         VALUES (@puuid, @gameName, @tagLine, @region, @lastMatchAt, @now)
         ON CONFLICT(puuid) DO UPDATE SET
           game_name = excluded.game_name, tag_line = excluded.tag_line, region = excluded.region,
           last_match_at = MAX(COALESCE(players.last_match_at, 0), COALESCE(excluded.last_match_at, 0)),
           updated_at = excluded.updated_at`,
      )
      .run({ ...p, now: Date.now() });
  }

  hasMatch(matchId: string): boolean {
    return !!this.db.prepare('SELECT 1 FROM matches WHERE match_id = ?').get(matchId);
  }

  saveMatch(raw: TftMatchDto, matchups: Array<{ puuid: string; matchup: Matchup }>): void {
    const insertMatch = this.db.prepare(
      `INSERT OR IGNORE INTO matches (match_id, game_datetime, queue_id, set_number, raw_json) VALUES (?, ?, ?, ?, ?)`,
    );
    const insertMatchup = this.db.prepare(
      `INSERT OR IGNORE INTO matchups (puuid, match_id, queue_type, placement, timestamp) VALUES (?, ?, ?, ?, ?)`,
    );
    this.db.transaction(() => {
      insertMatch.run(
        raw.metadata.match_id,
        raw.info.game_datetime,
        raw.info.queue_id,
        raw.info.tft_set_number,
        JSON.stringify(raw),
      );
      for (const { puuid, matchup: m } of matchups) {
        insertMatchup.run(puuid, m.matchId, m.queueType, m.placement, Date.parse(m.timestamp));
      }
    })();
  }

  /** Epoch ms of the newest match seen in this player's own match list, or null if never ingested. */
  playerSyncPoint(puuid: string): number | null {
    const row = this.db.prepare('SELECT last_match_at FROM players WHERE puuid = ?').get(puuid) as
      | { last_match_at: number | null }
      | undefined;
    return row?.last_match_at || null;
  }

  /** Newest game_datetime among the given (cached) match ids, or null. */
  newestMatchTime(matchIds: string[]): number | null {
    return this.matchTimeAgg('MAX', matchIds);
  }

  /** Oldest game_datetime among the given (cached) match ids, or null. */
  oldestMatchTime(matchIds: string[]): number | null {
    return this.matchTimeAgg('MIN', matchIds);
  }

  private matchTimeAgg(fn: 'MIN' | 'MAX', matchIds: string[]): number | null {
    if (!matchIds.length) return null;
    const row = this.db
      .prepare(`SELECT ${fn}(game_datetime) AS ts FROM matches WHERE match_id IN (${matchIds.map(() => '?').join(',')})`)
      .get(...matchIds) as { ts: number | null };
    return row.ts;
  }

  /** Set number of a cached match, or null if it isn't cached. */
  matchSet(matchId: string): number | null {
    const row = this.db.prepare('SELECT set_number FROM matches WHERE match_id = ?').get(matchId) as
      | { set_number: number | null }
      | undefined;
    return row?.set_number ?? null;
  }

  /** The newest set seen in any cached match: the current season. */
  latestSet(): number | null {
    const row = this.db.prepare('SELECT MAX(set_number) AS s FROM matches').get() as { s: number | null };
    return row.s;
  }

  findPlayer(gameName: string, tagLine: string, region: string): StoredPlayer | null {
    const row = this.db
      .prepare(
        `SELECT puuid, game_name, tag_line, region, last_match_at FROM players
         WHERE game_name = ? COLLATE NOCASE AND tag_line = ? COLLATE NOCASE AND region = ?
         ORDER BY updated_at DESC LIMIT 1`,
      )
      .get(gameName, tagLine, region.toLowerCase()) as
      | { puuid: string; game_name: string; tag_line: string; region: string; last_match_at: number | null }
      | undefined;
    return row
      ? { puuid: row.puuid, gameName: row.game_name, tagLine: row.tag_line, region: row.region, lastMatchAt: row.last_match_at }
      : null;
  }

  /** Every player the pipeline has loaded (lobby-mates without a profile load aren't included). */
  listPlayers(): StoredPlayer[] {
    const rows = this.db
      .prepare('SELECT puuid, game_name, tag_line, region, last_match_at FROM players ORDER BY game_name COLLATE NOCASE')
      .all() as Array<{ puuid: string; game_name: string; tag_line: string; region: string; last_match_at: number | null }>;
    return rows.map((r) => ({
      puuid: r.puuid,
      gameName: r.game_name,
      tagLine: r.tag_line,
      region: r.region,
      lastMatchAt: r.last_match_at,
    }));
  }

  getPlayer(puuid: string): StoredPlayer | null {
    const row = this.db
      .prepare('SELECT puuid, game_name, tag_line, region, last_match_at FROM players WHERE puuid = ?')
      .get(puuid) as
      | { puuid: string; game_name: string; tag_line: string; region: string; last_match_at: number | null }
      | undefined;
    return row
      ? { puuid: row.puuid, gameName: row.game_name, tagLine: row.tag_line, region: row.region, lastMatchAt: row.last_match_at }
      : null;
  }

  /** True once the player's history has been backfilled back to at least `minSet`. */
  historyComplete(puuid: string, minSet: number): boolean {
    const row = this.db.prepare('SELECT history_set FROM players WHERE puuid = ?').get(puuid) as
      | { history_set: number | null }
      | undefined;
    return row?.history_set != null && row.history_set <= minSet;
  }

  markHistoryComplete(puuid: string, minSet: number): void {
    this.db
      .prepare('UPDATE players SET history_set = MIN(COALESCE(history_set, ?), ?) WHERE puuid = ?')
      .run(minSet, minSet, puuid);
  }

  /** The player's matchups from `minSet` onward, newest first. */
  getMatchups(puuid: string, minSet: number): Matchup[] {
    const rows = this.db
      .prepare(
        `SELECT mu.match_id, mu.queue_type, mu.placement, mu.timestamp, m.set_number
         FROM matchups mu JOIN matches m ON m.match_id = mu.match_id
         WHERE mu.puuid = ? AND m.set_number >= ?
         ORDER BY mu.timestamp DESC`,
      )
      .all(puuid, minSet) as Array<{
      match_id: string;
      queue_type: QueueType;
      placement: number;
      timestamp: number;
      set_number: number;
    }>;
    return rows.map((r) => ({
      matchId: r.match_id,
      queueType: r.queue_type,
      placement: r.placement,
      timestamp: new Date(r.timestamp).toISOString(),
      set: r.set_number,
    }));
  }

  saveRankSnapshot(puuid: string, s: RankSnapshot): void {
    this.db
      .prepare(
        `INSERT INTO rank_snapshots (puuid, tier, division, league_points, wins, losses, fetched_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(puuid, s.tier, s.division, s.leaguePoints, s.wins, s.losses, s.fetchedAt);
  }

  /** Oldest first. */
  getRankSnapshots(puuid: string): RankSnapshot[] {
    const rows = this.db
      .prepare(
        `SELECT tier, division, league_points, wins, losses, fetched_at FROM rank_snapshots
         WHERE puuid = ? ORDER BY fetched_at ASC`,
      )
      .all(puuid) as Array<{
      tier: string;
      division: string;
      league_points: number;
      wins: number;
      losses: number;
      fetched_at: number;
    }>;
    return rows.map((r) => ({
      tier: r.tier,
      division: r.division,
      leaguePoints: r.league_points,
      wins: r.wins,
      losses: r.losses,
      fetchedAt: r.fetched_at,
    }));
  }

  close(): void {
    this.db.close();
  }
}

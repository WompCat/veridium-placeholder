import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import type { Matchup, QueueType, RankSnapshot, TftMatchDto } from '../types';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS players (
  puuid       TEXT PRIMARY KEY,
  game_name   TEXT NOT NULL,
  tag_line    TEXT NOT NULL,
  region      TEXT NOT NULL,
  -- game_datetime of the newest match in this player's own match-id list: the incremental cursor.
  -- (Not MAX(matchups.timestamp): lobby-mates' matchups get stored when someone else is ingested.)
  last_match_at  INTEGER,
  updated_at  INTEGER NOT NULL
);

-- Raw match JSON keyed by match id: a match is fetched from Riot at most once.
CREATE TABLE IF NOT EXISTS matches (
  match_id       TEXT PRIMARY KEY,
  game_datetime  INTEGER NOT NULL,
  queue_id       INTEGER NOT NULL,
  raw_json       TEXT NOT NULL
);

-- One row per participant per match (all 8 players, so lobby-mates are cached too).
CREATE TABLE IF NOT EXISTS matchups (
  puuid       TEXT NOT NULL,
  match_id    TEXT NOT NULL REFERENCES matches(match_id),
  queue_type  TEXT NOT NULL,
  placement   INTEGER NOT NULL,
  timestamp   INTEGER NOT NULL,
  PRIMARY KEY (puuid, match_id)
);
CREATE INDEX IF NOT EXISTS matchups_by_player ON matchups (puuid, timestamp DESC);

-- Rank is never cached per match; each ingestion run appends a fresh snapshot.
CREATE TABLE IF NOT EXISTS rank_snapshots (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  puuid          TEXT NOT NULL,
  tier           TEXT NOT NULL,
  division       TEXT NOT NULL,
  league_points  INTEGER NOT NULL,
  wins           INTEGER NOT NULL,
  losses         INTEGER NOT NULL,
  fetched_at     INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS rank_snapshots_by_player ON rank_snapshots (puuid, fetched_at);
`;

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
    this.db.exec(SCHEMA);
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
      `INSERT OR IGNORE INTO matches (match_id, game_datetime, queue_id, raw_json) VALUES (?, ?, ?, ?)`,
    );
    const insertMatchup = this.db.prepare(
      `INSERT OR IGNORE INTO matchups (puuid, match_id, queue_type, placement, timestamp) VALUES (?, ?, ?, ?, ?)`,
    );
    this.db.transaction(() => {
      insertMatch.run(raw.metadata.match_id, raw.info.game_datetime, raw.info.queue_id, JSON.stringify(raw));
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
    if (!matchIds.length) return null;
    const row = this.db
      .prepare(`SELECT MAX(game_datetime) AS ts FROM matches WHERE match_id IN (${matchIds.map(() => '?').join(',')})`)
      .get(...matchIds) as { ts: number | null };
    return row.ts;
  }

  /** Newest first. */
  getMatchups(puuid: string, limit: number): Matchup[] {
    const rows = this.db
      .prepare(
        `SELECT match_id, queue_type, placement, timestamp FROM matchups
         WHERE puuid = ? ORDER BY timestamp DESC LIMIT ?`,
      )
      .all(puuid, limit) as Array<{ match_id: string; queue_type: QueueType; placement: number; timestamp: number }>;
    return rows.map((r) => ({
      matchId: r.match_id,
      queueType: r.queue_type,
      placement: r.placement,
      timestamp: new Date(r.timestamp).toISOString(),
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

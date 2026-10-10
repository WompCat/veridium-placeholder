import type Database from 'better-sqlite3';
import type { LolLeagueEntryDto, LolMatchDto, LolQueue, LolRank } from './types';

/** Calendar-year season of a LoL game (UTC). */
export const seasonOf = (epochMs: number) => new Date(epochMs).getUTCFullYear();

export interface LolParticipantRow {
  matchId: string;
  gameEnd: number;
  queueId: number;
  season: number;
  duration: number;
  champion: string;
  role: string;
  win: boolean;
  kills: number;
  deaths: number;
  assists: number;
  cs: number;
}

/** sqlite access for League of Legends data (tables from migrations/004_lol.sql). */
export class LolStore {
  constructor(private db: Database.Database) {}

  hasMatch(matchId: string): boolean {
    return !!this.db.prepare('SELECT 1 FROM lol_matches WHERE match_id = ?').get(matchId);
  }

  matchSeason(matchId: string): number | null {
    const row = this.db.prepare('SELECT season FROM lol_matches WHERE match_id = ?').get(matchId) as
      | { season: number }
      | undefined;
    return row?.season ?? null;
  }

  saveMatch(raw: LolMatchDto): void {
    const { info, metadata } = raw;
    const insertMatch = this.db.prepare(
      `INSERT OR IGNORE INTO lol_matches (match_id, game_end, queue_id, season, duration, raw_json) VALUES (?, ?, ?, ?, ?, ?)`,
    );
    const insertParticipant = this.db.prepare(
      `INSERT OR IGNORE INTO lol_participants (puuid, match_id, champion, role, win, kills, deaths, assists, cs)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    this.db.transaction(() => {
      insertMatch.run(
        metadata.matchId,
        info.gameEndTimestamp,
        info.queueId,
        seasonOf(info.gameEndTimestamp),
        info.gameDuration,
        JSON.stringify(raw),
      );
      for (const p of info.participants) {
        insertParticipant.run(
          p.puuid,
          metadata.matchId,
          p.championName,
          p.teamPosition ?? '',
          p.win ? 1 : 0,
          p.kills,
          p.deaths,
          p.assists,
          p.totalMinionsKilled + p.neutralMinionsKilled,
        );
      }
    })();
  }

  newestGameEnd(matchIds: string[]): number | null {
    return this.gameEndAgg('MAX', matchIds);
  }

  oldestGameEnd(matchIds: string[]): number | null {
    return this.gameEndAgg('MIN', matchIds);
  }

  private gameEndAgg(fn: 'MIN' | 'MAX', matchIds: string[]): number | null {
    if (!matchIds.length) return null;
    const row = this.db
      .prepare(`SELECT ${fn}(game_end) AS ts FROM lol_matches WHERE match_id IN (${matchIds.map(() => '?').join(',')})`)
      .get(...matchIds) as { ts: number | null };
    return row.ts;
  }

  /** The player's ranked games in a season, newest first. */
  getParticipations(puuid: string, season: number): LolParticipantRow[] {
    const rows = this.db
      .prepare(
        `SELECT p.match_id, m.game_end, m.queue_id, m.season, m.duration, p.champion, p.role, p.win,
                p.kills, p.deaths, p.assists, p.cs
         FROM lol_participants p JOIN lol_matches m ON m.match_id = p.match_id
         WHERE p.puuid = ? AND m.season = ?
         ORDER BY m.game_end DESC`,
      )
      .all(puuid, season) as Array<Record<string, number | string>>;
    return rows.map((r) => ({
      matchId: r.match_id as string,
      gameEnd: r.game_end as number,
      queueId: r.queue_id as number,
      season: r.season as number,
      duration: r.duration as number,
      champion: r.champion as string,
      role: r.role as string,
      win: r.win === 1,
      kills: r.kills as number,
      deaths: r.deaths as number,
      assists: r.assists as number,
      cs: r.cs as number,
    }));
  }

  saveRanks(puuid: string, entries: LolLeagueEntryDto[], fetchedAt: number): void {
    const insert = this.db.prepare(
      `INSERT INTO lol_rank_snapshots (puuid, queue, tier, division, league_points, wins, losses, fetched_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const e of entries) {
      if (e.queueType !== 'RANKED_SOLO_5x5' && e.queueType !== 'RANKED_FLEX_SR') continue;
      insert.run(puuid, e.queueType, e.tier, e.rank, e.leaguePoints, e.wins, e.losses, fetchedAt);
    }
  }

  latestRank(puuid: string, queue: LolQueue): LolRank | null {
    const row = this.db
      .prepare(
        `SELECT tier, division, league_points, wins, losses FROM lol_rank_snapshots
         WHERE puuid = ? AND queue = ? ORDER BY fetched_at DESC, id DESC LIMIT 1`,
      )
      .get(puuid, queue) as
      | { tier: string; division: string; league_points: number; wins: number; losses: number }
      | undefined;
    return row
      ? { tier: row.tier, division: row.division, leaguePoints: row.league_points, wins: row.wins, losses: row.losses }
      : null;
  }

  syncPoint(puuid: string): number | null {
    const row = this.db.prepare('SELECT last_match_at FROM lol_sync WHERE puuid = ?').get(puuid) as
      | { last_match_at: number | null }
      | undefined;
    return row?.last_match_at || null;
  }

  setSyncPoint(puuid: string, lastMatchAt: number | null): void {
    this.db
      .prepare(
        `INSERT INTO lol_sync (puuid, last_match_at) VALUES (?, ?)
         ON CONFLICT(puuid) DO UPDATE SET
           last_match_at = MAX(COALESCE(lol_sync.last_match_at, 0), COALESCE(excluded.last_match_at, 0))`,
      )
      .run(puuid, lastMatchAt);
  }

  historyComplete(puuid: string, season: number): boolean {
    const row = this.db.prepare('SELECT history_season FROM lol_sync WHERE puuid = ?').get(puuid) as
      | { history_season: number | null }
      | undefined;
    return row?.history_season != null && row.history_season <= season;
  }

  markHistoryComplete(puuid: string, season: number): void {
    this.db
      .prepare(
        `INSERT INTO lol_sync (puuid, history_season) VALUES (?, ?)
         ON CONFLICT(puuid) DO UPDATE SET history_season = MIN(COALESCE(lol_sync.history_season, excluded.history_season), excluded.history_season)`,
      )
      .run(puuid, season);
  }

  /** Whether Veridium has any LoL data for this player (they've been loaded for LoL at least once). */
  hasPlayer(puuid: string): boolean {
    return !!this.db.prepare('SELECT 1 FROM lol_sync WHERE puuid = ?').get(puuid);
  }
}

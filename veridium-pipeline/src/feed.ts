import type { OrgRepo } from './orgs/repo';
import { playerSummary } from './orgs/players';
import { ladderScore } from './tft/aggregate';
import type { IngestDeps } from './tft/ingest';
import type { PlayerSummary, QueueType } from './types';

// The home feed is built from what actually happened on the platform. There are no user posts yet.

export interface SessionItem {
  type: 'session'; // one player's TFT games on one day
  at: string; // newest game in the session
  player: PlayerSummary;
  date: string; // YYYY-MM-DD
  set: number;
  games: Array<{ matchId: string; placement: number; queueType: QueueType }>; // newest first
  rankedGames: number;
  best: number;
  avgPlacement: number;
}

export interface RosterJoinItem {
  type: 'roster_join';
  at: string;
  organization: { id: string; name: string };
  player: PlayerSummary;
  role: string;
  status: 'active' | 'bench';
  roster: Array<{ riotId: string; role: string }>; // the org's current roster
}

export interface VacancyItem {
  type: 'vacancy';
  at: string;
  organization: { id: string; name: string };
  vacancy: { id: string; title: string; role: string | null; game: string; region: string; level: string; status: string };
}

export type FeedItem = SessionItem | RosterJoinItem | VacancyItem;

const RECENT_MATCHUPS = 400; // how far back to look for sessions

export function buildFeed(deps: IngestDeps & { orgs: OrgRepo }, limit = 20): FeedItem[] {
  const db = deps.store.db;
  const summaries = new Map<string, PlayerSummary | null>();
  const summary = (puuid: string) => {
    if (!summaries.has(puuid)) summaries.set(puuid, playerSummary(deps, puuid));
    return summaries.get(puuid)!;
  };

  // Sessions: only players who've been loaded (lobby-mates have matchups but no players row).
  const matchups = db
    .prepare(
      `SELECT mu.puuid, mu.match_id, mu.queue_type, mu.placement, mu.timestamp, m.set_number
       FROM matchups mu
       JOIN players p ON p.puuid = mu.puuid
       JOIN matches m ON m.match_id = mu.match_id
       ORDER BY mu.timestamp DESC LIMIT ?`,
    )
    .all(RECENT_MATCHUPS) as Array<{
    puuid: string;
    match_id: string;
    queue_type: QueueType;
    placement: number;
    timestamp: number;
    set_number: number;
  }>;
  const sessions = new Map<string, SessionItem>();
  for (const m of matchups) {
    const date = new Date(m.timestamp).toISOString().slice(0, 10);
    const key = `${m.puuid}|${date}`;
    let s = sessions.get(key);
    if (!s) {
      const player = summary(m.puuid);
      if (!player) continue;
      s = {
        type: 'session',
        at: new Date(m.timestamp).toISOString(),
        player,
        date,
        set: m.set_number,
        games: [],
        rankedGames: 0,
        best: 8,
        avgPlacement: 0,
      };
      sessions.set(key, s);
    }
    s.games.push({ matchId: m.match_id, placement: m.placement, queueType: m.queue_type });
  }
  for (const s of sessions.values()) {
    s.rankedGames = s.games.filter((g) => g.queueType === 'RANKED_TFT').length;
    s.best = Math.min(...s.games.map((g) => g.placement));
    s.avgPlacement = Math.round((s.games.reduce((t, g) => t + g.placement, 0) / s.games.length) * 10) / 10;
  }

  const rosters = new Map<string, Array<{ riotId: string; role: string }>>();
  const rosterOf = (orgId: string) => {
    if (!rosters.has(orgId)) {
      rosters.set(
        orgId,
        deps.orgs.listRoster(orgId).flatMap((m) => {
          const p = summary(m.playerPuuid);
          return p ? [{ riotId: p.riotId, role: m.role }] : [];
        }),
      );
    }
    return rosters.get(orgId)!;
  };

  const joins = db
    .prepare(
      `SELECT m.player_puuid, m.role, m.status, m.joined_at, o.id AS org_id, o.name AS org_name
       FROM org_memberships m JOIN organizations o ON o.id = m.organization_id
       ORDER BY m.joined_at DESC LIMIT ?`,
    )
    .all(limit) as Array<{
    player_puuid: string;
    role: string;
    status: 'active' | 'bench';
    joined_at: string;
    org_id: string;
    org_name: string;
  }>;
  const joinItems: RosterJoinItem[] = joins.flatMap((j) => {
    const player = summary(j.player_puuid);
    return player
      ? [
          {
            type: 'roster_join' as const,
            at: j.joined_at,
            organization: { id: j.org_id, name: j.org_name },
            player,
            role: j.role,
            status: j.status,
            roster: rosterOf(j.org_id),
          },
        ]
      : [];
  });

  const vacancyItems: VacancyItem[] = deps.orgs.listVacancies({}).slice(0, limit).map((v) => ({
    type: 'vacancy',
    at: v.postedAt,
    organization: { id: v.organizationId, name: v.organizationName },
    vacancy: { id: v.id, title: v.title, role: v.role, game: v.game, region: v.region, level: v.level, status: v.status },
  }));

  return [...sessions.values(), ...joinItems, ...vacancyItems]
    .sort((a, b) => b.at.localeCompare(a.at))
    .slice(0, limit);
}

/** Loaded players with their verified summary: ranked players first (highest rank first), then by name. */
export function listPlayerSummaries(deps: IngestDeps): PlayerSummary[] {
  const players = deps.store.listPlayers().flatMap((p) => {
    const s = playerSummary(deps, p.puuid);
    return s ? [s] : [];
  });
  return players.sort((a, b) => {
    if (a.rank && b.rank) return ladderScore(b.rank) - ladderScore(a.rank) || a.riotId.localeCompare(b.riotId);
    if (a.rank || b.rank) return a.rank ? -1 : 1;
    return a.riotId.localeCompare(b.riotId);
  });
}

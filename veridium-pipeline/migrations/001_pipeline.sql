-- TFT ingestion pipeline tables. IF NOT EXISTS so databases created before the
-- migrations folder existed adopt this as their baseline without changes.

CREATE TABLE IF NOT EXISTS players (
  puuid       TEXT PRIMARY KEY,
  game_name   TEXT NOT NULL,
  tag_line    TEXT NOT NULL,
  region      TEXT NOT NULL,
  -- game_datetime of the newest match in this player's own match-id list: the incremental cursor.
  -- (Not MAX(matchups.timestamp): lobby-mates' matchups get stored when someone else is ingested.)
  last_match_at  INTEGER,
  -- Oldest set whose full history has been backfilled for this player (null = never finished).
  history_set    INTEGER,
  updated_at  INTEGER NOT NULL
);

-- Raw match JSON keyed by match id: a match is fetched from Riot at most once.
CREATE TABLE IF NOT EXISTS matches (
  match_id       TEXT PRIMARY KEY,
  game_datetime  INTEGER NOT NULL,
  queue_id       INTEGER NOT NULL,
  set_number     INTEGER,
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

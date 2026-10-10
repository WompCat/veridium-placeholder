-- League of Legends: ranked matches, per-player rows, rank snapshots and sync state.
-- Kept apart from the TFT tables: different match shape (champions, KDA, wins) and seasons
-- (a LoL season is a calendar year; a TFT season is a set).

CREATE TABLE lol_matches (
  match_id   TEXT PRIMARY KEY,
  game_end   INTEGER NOT NULL, -- epoch ms
  queue_id   INTEGER NOT NULL, -- 420 Ranked Solo/Duo, 440 Ranked Flex
  season     INTEGER NOT NULL, -- calendar year of game_end (UTC)
  duration   INTEGER NOT NULL, -- seconds
  raw_json   TEXT NOT NULL
);

-- One row per participant (all 10), so lobby-mates' later loads are cheaper too.
CREATE TABLE lol_participants (
  puuid     TEXT NOT NULL,
  match_id  TEXT NOT NULL REFERENCES lol_matches(match_id),
  champion  TEXT NOT NULL,
  role      TEXT NOT NULL, -- TOP, JUNGLE, MIDDLE, BOTTOM, UTILITY, or '' when Riot doesn't say
  win       INTEGER NOT NULL,
  kills     INTEGER NOT NULL,
  deaths    INTEGER NOT NULL,
  assists   INTEGER NOT NULL,
  cs        INTEGER NOT NULL,
  PRIMARY KEY (puuid, match_id)
);
CREATE INDEX lol_participants_by_match ON lol_participants (match_id);

CREATE TABLE lol_rank_snapshots (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  puuid          TEXT NOT NULL,
  queue          TEXT NOT NULL, -- RANKED_SOLO_5x5 or RANKED_FLEX_SR
  tier           TEXT NOT NULL,
  division       TEXT NOT NULL,
  league_points  INTEGER NOT NULL,
  wins           INTEGER NOT NULL,
  losses         INTEGER NOT NULL,
  fetched_at     INTEGER NOT NULL
);
CREATE INDEX lol_rank_snapshots_by_player ON lol_rank_snapshots (puuid, queue, fetched_at);

-- Incremental cursor and backfill marker per player (same idea as players.last_match_at / history_set).
CREATE TABLE lol_sync (
  puuid           TEXT PRIMARY KEY REFERENCES players(puuid),
  last_match_at   INTEGER, -- game_end of the newest match in the player's own ranked list
  history_season  INTEGER  -- oldest season fully backfilled
);

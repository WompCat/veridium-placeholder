-- Self-reported team history: past teams a player lists on their own profile. Always shown labelled
-- "Self-reported", separately from teams verified by a Veridium org's roster.
CREATE TABLE team_history (
  id           TEXT PRIMARY KEY,
  player_puuid TEXT NOT NULL REFERENCES players(puuid),
  team         TEXT NOT NULL,
  role         TEXT,
  game         TEXT,
  started      TEXT NOT NULL,  -- YYYY-MM
  ended        TEXT,           -- YYYY-MM, or NULL for "present"
  created_at   TEXT NOT NULL
);
CREATE INDEX team_history_player ON team_history(player_puuid);

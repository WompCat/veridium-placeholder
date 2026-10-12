-- Tournament organizers and their results: the third credential tier, next to Riot stats and team history.
-- An account applies to be an organizer; Veridium staff approve it. Only approved organizers' tournaments
-- and results are shown publicly.
CREATE TABLE organizers (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  website     TEXT,
  description TEXT,
  status      TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'rejected')),
  created_at  TEXT NOT NULL,
  decided_at  TEXT
);

CREATE TABLE tournaments (
  id           TEXT PRIMARY KEY,
  organizer_id TEXT NOT NULL REFERENCES organizers(id) ON DELETE CASCADE,
  name         TEXT NOT NULL,
  game         TEXT NOT NULL,
  date         TEXT NOT NULL,  -- YYYY-MM-DD (the final day)
  region       TEXT,
  url          TEXT,
  created_at   TEXT NOT NULL
);
CREATE INDEX tournaments_organizer ON tournaments(organizer_id);

CREATE TABLE tournament_results (
  id            TEXT PRIMARY KEY,
  tournament_id TEXT NOT NULL REFERENCES tournaments(id) ON DELETE CASCADE,
  player_puuid  TEXT NOT NULL REFERENCES players(puuid),
  placement     INTEGER NOT NULL CHECK (placement >= 1),
  team          TEXT,
  hidden        INTEGER NOT NULL DEFAULT 0,  -- 1: the player marked it "Not me"
  created_at    TEXT NOT NULL,
  UNIQUE (tournament_id, player_puuid)
);
CREATE INDEX tournament_results_player ON tournament_results(player_puuid);

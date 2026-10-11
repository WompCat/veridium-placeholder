-- Accounts following players (by PUUID) and organizations. Who follows whom isn't shown to anyone
-- else; pages only show follower counts.
CREATE TABLE follows (
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  target_type TEXT NOT NULL CHECK (target_type IN ('player', 'org')),
  target_id   TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  PRIMARY KEY (user_id, target_type, target_id)
);
CREATE INDEX follows_target ON follows(target_type, target_id);

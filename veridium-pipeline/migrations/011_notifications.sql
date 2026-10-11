-- On-site notifications. Each row belongs to one account and carries only what that account may
-- already see (e.g. a player's own application outcome; never another applicant's details).
CREATE TABLE notifications (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type       TEXT NOT NULL,   -- application.received | application.accepted | application.rejected | roster.added | roster.removed
  text       TEXT NOT NULL,
  link       TEXT NOT NULL,
  created_at TEXT NOT NULL,
  read_at    TEXT
);
CREATE INDEX notifications_user ON notifications(user_id, created_at);

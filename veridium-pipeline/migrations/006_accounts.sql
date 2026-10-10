-- Accounts. Email + password login; a Riot ID can be linked to one account at most.
CREATE TABLE users (
  id            TEXT PRIMARY KEY,
  email         TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT NOT NULL,                       -- scrypt, see src/auth/passwords.ts
  player_puuid  TEXT UNIQUE REFERENCES players(puuid),
  created_at    TEXT NOT NULL
);

-- Server-side sessions. Only a SHA-256 of the cookie token is stored, so a leaked db can't log anyone in.
CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE INDEX sessions_user ON sessions(user_id);

-- Who manages an organization: its roster, vacancies and applicants.
CREATE TABLE org_admins (
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at      TEXT NOT NULL,
  PRIMARY KEY (organization_id, user_id)
);
CREATE INDEX org_admins_user ON org_admins(user_id);

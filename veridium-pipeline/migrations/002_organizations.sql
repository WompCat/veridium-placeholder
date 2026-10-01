-- Organizations, rosters, vacancies and applications (org & vacancy backend).
-- Player stats are never copied here: rows reference players.puuid and stats are read
-- from the pipeline's tables at request time.

CREATE TABLE organizations (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  created_at  TEXT NOT NULL
);

-- One row per stint on a roster. Leaving sets left_at; rejoining adds a new row.
CREATE TABLE org_memberships (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  player_puuid     TEXT NOT NULL REFERENCES players(puuid),
  organization_id  TEXT NOT NULL REFERENCES organizations(id),
  role             TEXT NOT NULL,
  status           TEXT NOT NULL CHECK (status IN ('active', 'bench')),
  joined_at        TEXT NOT NULL,
  left_at          TEXT
);
-- A player can only be on an org's current roster once.
CREATE UNIQUE INDEX org_memberships_current ON org_memberships (organization_id, player_puuid) WHERE left_at IS NULL;
CREATE INDEX org_memberships_by_player ON org_memberships (player_puuid);

CREATE TABLE vacancies (
  id               TEXT PRIMARY KEY,
  organization_id  TEXT NOT NULL REFERENCES organizations(id),
  title            TEXT NOT NULL,
  game             TEXT NOT NULL,
  region           TEXT NOT NULL,
  level            TEXT NOT NULL CHECK (level IN ('competitive', 'casual')),
  status           TEXT NOT NULL CHECK (status IN ('open', 'closed')),
  posted_at        TEXT NOT NULL
);
CREATE INDEX vacancies_by_org ON vacancies (organization_id, posted_at DESC);
CREATE INDEX vacancies_listing ON vacancies (status, game, region);

CREATE TABLE applications (
  id            TEXT PRIMARY KEY,
  vacancy_id    TEXT NOT NULL REFERENCES vacancies(id),
  player_puuid  TEXT NOT NULL REFERENCES players(puuid),
  status        TEXT NOT NULL CHECK (status IN ('pending', 'accepted', 'rejected')),
  applied_at    TEXT NOT NULL,
  UNIQUE (vacancy_id, player_puuid)
);

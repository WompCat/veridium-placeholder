-- Vacancies name the roster role they're for (e.g. "Flex", "Sub", "Coach"), so players can
-- filter by it and an accepted applicant's roster entry can be pre-filled from it.
ALTER TABLE vacancies ADD COLUMN role TEXT;

-- A player's own applications, for their "My applications" view.
CREATE INDEX applications_by_player ON applications (player_puuid, applied_at DESC);

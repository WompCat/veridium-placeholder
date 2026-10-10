-- Remakes (games ended by early surrender, usually within ~3 minutes) aren't real games: they're
-- kept in match history but excluded from stats. Riot flags them per participant.
ALTER TABLE lol_matches ADD COLUMN remake INTEGER NOT NULL DEFAULT 0;
UPDATE lol_matches SET remake = 1
  WHERE json_extract(raw_json, '$.info.participants[0].gameEndedInEarlySurrender') = 1;

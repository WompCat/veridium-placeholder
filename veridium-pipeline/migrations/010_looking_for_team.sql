-- "Looking for team": a player opts in from their account so orgs can find them in the player search.
ALTER TABLE users ADD COLUMN looking_for_team INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN lft_roles TEXT; -- optional, free text such as "Flex, Sub"

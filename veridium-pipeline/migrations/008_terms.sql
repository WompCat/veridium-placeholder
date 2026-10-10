-- Which version of the Terms of Service and Privacy Policy each account accepted, and when.
-- NULL (accounts made before this) means they're asked to accept on their next visit.
ALTER TABLE users ADD COLUMN terms_version TEXT;
ALTER TABLE users ADD COLUMN terms_accepted_at TEXT;

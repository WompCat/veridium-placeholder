-- Public org profile fields, and a "verified" badge that only Veridium's site admins can grant.
ALTER TABLE organizations ADD COLUMN description TEXT;
ALTER TABLE organizations ADD COLUMN website TEXT;
ALTER TABLE organizations ADD COLUMN verified_at TEXT;

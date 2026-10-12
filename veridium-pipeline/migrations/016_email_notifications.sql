-- Email copies of on-site notifications (sent only when an email service is configured).
-- On by default; each account can turn them off in Account settings.
ALTER TABLE users ADD COLUMN email_notifications INTEGER NOT NULL DEFAULT 1;

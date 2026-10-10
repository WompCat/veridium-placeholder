-- Self-reported "I am under 18" on an application (1 = yes). Only the organization the application
-- was sent to ever sees it, so it knows parental/guardian consent applies before any offer.
-- A yes/no only: no birthdate or age is collected anywhere.
ALTER TABLE applications ADD COLUMN under_18 INTEGER NOT NULL DEFAULT 0;

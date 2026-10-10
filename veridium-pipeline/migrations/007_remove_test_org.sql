-- Obscurity Esports was a test org created by the old seed script. Remove it and everything
-- attached to it (organizations have no ON DELETE CASCADE, so children go first).
DELETE FROM applications WHERE vacancy_id IN (SELECT id FROM vacancies WHERE organization_id = 'obscurity-esports');
DELETE FROM vacancies WHERE organization_id = 'obscurity-esports';
DELETE FROM org_memberships WHERE organization_id = 'obscurity-esports';
DELETE FROM org_admins WHERE organization_id = 'obscurity-esports';
DELETE FROM organizations WHERE id = 'obscurity-esports';

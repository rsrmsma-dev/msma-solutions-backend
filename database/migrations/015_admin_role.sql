-- 015: The Admin role: the owner company's own role (us), with Super Admin's access. Only a System Admin
-- creates Admin accounts, and the client doesn't see them. Who may create which role is enforced by
-- the server (server/src/hierarchy.ts): System Admin creates everyone; Super Admin builds the client's
-- hierarchy; HR creates employee sign-ins. No account changes. Can only run once (schema_migrations).
-- Run as the database owner (postgres):
--   psql -U postgres -d heyhr -v ON_ERROR_STOP=1 -f database/migrations/015_admin_role.sql

BEGIN;

INSERT INTO schema_migrations (version) VALUES ('015_admin_role');

ALTER TABLE roles DROP CONSTRAINT roles_role_key_check;
ALTER TABLE roles ADD CONSTRAINT roles_role_key_check CHECK (role_key IN ('system_admin', 'admin', 'super_admin', 'hr', 'approver', 'accounting', 'employee'));

INSERT INTO roles (id, role_key, name, description, workspace, is_built_in, is_super_admin)
VALUES ('admin', 'admin', 'Admin', 'The owner company (us). Super Admin''s access across the system; created only by a System Admin and hidden from the client.', 'admin', true, false);

COMMENT ON TABLE roles IS 'The fixed roles: the website''s six (access matrix in src/lib/permissions.ts) plus Admin, the owner company''s own role with Super Admin''s access. Who may create which is in server/src/hierarchy.ts.';
COMMENT ON COLUMN roles.role_key IS 'Which role: the access matrix''s six, or admin (ours).';

COMMIT;

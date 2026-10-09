-- 014: Self-registration (the website's Register form). HR adds the employee first; the person then
-- registers, and the request is accepted only when their name, mobile and email match that employee.
-- The Super Admin reviews the request and creates the sign-in. New table and numbering only.
-- Can only run once (schema_migrations). Run as the database owner (postgres):
--   psql -U postgres -d heyhr -v ON_ERROR_STOP=1 -f database/migrations/014_registration_requests.sql

BEGIN;

INSERT INTO schema_migrations (version) VALUES ('014_registration_requests');

-- Sign-in requests from the Register form. Accepted only when the name, mobile and email match an employee HR already added; the Super Admin then creates the sign-in.
CREATE TABLE registration_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reference_no text NOT NULL UNIQUE,
  employee_id varchar(20) NOT NULL,
  full_name text NOT NULL,
  email text NOT NULL,
  mobile_no varchar(11) NOT NULL,
  position text,
  office text,
  cluster text,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  submitted_at timestamptz NOT NULL DEFAULT now(),
  account_id uuid,
  decided_by uuid,
  decided_by_name text,
  decided_at timestamptz,
  decision_note text
);

CREATE UNIQUE INDEX registration_requests_one_pending ON registration_requests (employee_id) WHERE status = 'pending';
CREATE SEQUENCE registration_no_seq; -- REG-00001 numbering
ALTER TABLE registration_requests ADD CONSTRAINT registration_requests_employee_id_fkey FOREIGN KEY (employee_id) REFERENCES employees (employee_id) ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE registration_requests ADD CONSTRAINT registration_requests_account_id_fkey FOREIGN KEY (account_id) REFERENCES user_accounts (id) ON DELETE SET NULL;
ALTER TABLE registration_requests ADD CONSTRAINT registration_requests_decided_by_fkey FOREIGN KEY (decided_by) REFERENCES user_accounts (id) ON DELETE SET NULL;
CREATE INDEX ON registration_requests (account_id);
CREATE INDEX ON registration_requests (decided_by);
CREATE INDEX ON registration_requests (employee_id);

-- The app's database login (heyhr_app, made by server/setup-db.ps1) can use them.
GRANT SELECT, INSERT, UPDATE, DELETE ON registration_requests TO heyhr_app;
GRANT USAGE, SELECT ON SEQUENCE registration_no_seq TO heyhr_app;

COMMENT ON TABLE registration_requests IS 'Sign-in requests from the Register form. Accepted only when the name, mobile and email match an employee HR already added; the Super Admin then creates the sign-in.';
COMMENT ON COLUMN registration_requests.id IS 'Primary key.';
COMMENT ON COLUMN registration_requests.reference_no IS 'Shown to the person after registering, e.g. REG-00001.';
COMMENT ON COLUMN registration_requests.employee_id IS 'The employee record the details matched.';
COMMENT ON COLUMN registration_requests.full_name IS 'Name as they typed it.';
COMMENT ON COLUMN registration_requests.email IS 'Email as they typed it (matched the record).';
COMMENT ON COLUMN registration_requests.mobile_no IS 'Mobile as they typed it, as 09XXXXXXXXX (matched the record).';
COMMENT ON COLUMN registration_requests.position IS 'Position they picked on the form (for review; not part of the match).';
COMMENT ON COLUMN registration_requests.office IS 'Office they picked on the form (for review; not part of the match).';
COMMENT ON COLUMN registration_requests.cluster IS 'Cluster they picked on the form (for review; not part of the match).';
COMMENT ON COLUMN registration_requests.status IS 'Waiting for review, approved (sign-in created) or rejected.';
COMMENT ON COLUMN registration_requests.submitted_at IS 'When they registered.';
COMMENT ON COLUMN registration_requests.account_id IS 'The sign-in created when it was approved.';
COMMENT ON COLUMN registration_requests.decided_by IS 'Account that approved or declined it.';
COMMENT ON COLUMN registration_requests.decided_by_name IS 'Name of who decided, kept if the account goes.';
COMMENT ON COLUMN registration_requests.decided_at IS 'When it was decided.';
COMMENT ON COLUMN registration_requests.decision_note IS 'Note from the approver to the employee.';

COMMIT;

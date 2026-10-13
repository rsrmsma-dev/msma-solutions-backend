-- One-off, after migration 018: marks claims that an earlier payroll run already paid (found with
-- database/tools/check-claims-before-018.sql) as paid with that run, so the next run doesn't pay them again.
--
-- Give the run and the claim ids explicitly, one run at a time. Every claim must be approved, not
-- marked paid yet, belong to an employee paid in that run, and have been approved before the run was;
-- otherwise nothing is changed. Without -v confirm=yes it only shows what it would do (dry run).
--
--   psql -U postgres -d heyhr -v ON_ERROR_STOP=1 -v run=<run id> -v claims=<claim id>,<claim id> -f database/tools/mark-claims-paid.sql
--   psql -U postgres -d heyhr -v ON_ERROR_STOP=1 -v run=<run id> -v claims=<claim id>,<claim id> -v confirm=yes -f database/tools/mark-claims-paid.sql
--
-- The payout is recorded as "payroll", paid when the run was approved, by whoever approved it. The
-- reference (normally the run's name, encrypted by the app) is left empty, since only the app can encrypt.

-- Only -v confirm=yes saves; anything else (no confirm, or another value) is a dry run. It takes the
-- same lock as payroll approval and final pay release, so neither can pay these claims meanwhile.

\set ON_ERROR_STOP on
\if :{?confirm}
SELECT (:'confirm' = 'yes') AS do_commit \gset
\else
\set do_commit false
\endif

BEGIN;
-- The lock payroll runs and final pay releases take before paying claims.
SELECT pg_advisory_xact_lock(hashtext('payroll-automatic-items')) \gset

CREATE TEMP TABLE picked_claims ON COMMIT DROP AS
  SELECT DISTINCT trim(x)::uuid AS id FROM unnest(string_to_array(:'claims', ',')) AS x WHERE trim(x) <> '';
CREATE TEMP TABLE picked_run ON COMMIT DROP AS
  SELECT id, label, approved_at, approved_by, approved_by_name FROM payroll_runs WHERE id = :'run'::uuid AND status = 'approved';

DO $guard$
DECLARE bad text; picked int; changed int;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM picked_run) THEN
    RAISE EXCEPTION 'That payroll run doesn''t exist or isn''t approved. Nothing was changed.';
  END IF;
  SELECT count(*) INTO picked FROM picked_claims;
  IF picked = 0 THEN
    RAISE EXCEPTION 'Give the claim ids with -v claims=<id>,<id>. Nothing was changed.';
  END IF;
  -- Hold the claims until the end, so nothing else changes them in between.
  PERFORM 1 FROM reimbursement_claims WHERE id IN (SELECT id FROM picked_claims) FOR UPDATE;
  SELECT string_agg(p.id::text, ', ') INTO bad
    FROM picked_claims p
    LEFT JOIN reimbursement_claims c ON c.id = p.id
    CROSS JOIN picked_run r
   WHERE c.id IS NULL
      OR c.status <> 'approved'
      OR c.paid_at IS NOT NULL
      OR c.decided_at IS NULL
      OR c.decided_at >= r.approved_at
      OR NOT EXISTS (SELECT 1 FROM payroll_run_lines l WHERE l.payroll_run_id = r.id AND l.employee_id = c.employee_id);
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'These claims can''t be marked paid with this run (missing, not approved, already paid, no approval date, approved after the run, or the employee isn''t in it): %. Nothing was changed.', bad;
  END IF;
  UPDATE reimbursement_claims c
     SET paid_at = r.approved_at, paid_by = r.approved_by, paid_by_name = r.approved_by_name, payout_method = 'payroll'
    FROM picked_run r
   WHERE c.id IN (SELECT id FROM picked_claims) AND c.paid_at IS NULL AND c.status = 'approved';
  GET DIAGNOSTICS changed = ROW_COUNT;
  IF changed <> picked THEN
    RAISE EXCEPTION 'Only % of the % claims could be marked paid (something else paid them meanwhile). Nothing was changed.', changed, picked;
  END IF;
END
$guard$;

SELECT c.id AS claim_id, c.employee_id, c.amount, r.label AS paid_with_run, c.paid_at
  FROM reimbursement_claims c, picked_run r WHERE c.id IN (SELECT id FROM picked_claims);

\if :do_commit
COMMIT;
\echo 'Done: the claims above are marked paid with that run.'
\else
ROLLBACK;
\echo 'Dry run: nothing was changed. Only -v confirm=yes saves.'
\endif

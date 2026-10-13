-- Read-only check: approved reimbursement claims that an earlier payroll run may already have paid.
--
-- Before migration 018 the server didn't record payouts: in server mode every approved claim was added
-- to every payroll run worked out after it was approved, and approving the run didn't mark it paid. So
-- on a database used that way, approved claims all look unpaid, and the next run would pay them again.
--
-- This lists each approved claim that isn't marked paid, with every approved payroll run approved after
-- the claim's final approval in which that employee was paid. The claim was most likely paid in the
-- FIRST run listed for it (run_non_taxable_items on that run's line shows the non-taxable items that
-- run added, reimbursements included; compare it with the claim amount). Nothing is changed.
--
-- Run it before applying 018, and again before the next payroll run (it works before and after 018):
--   psql -U postgres -d heyhr -v ON_ERROR_STOP=1 -f database/tools/check-claims-before-018.sql
-- Then mark the claims that were paid with database/tools/mark-claims-paid.sql (after 018).

BEGIN TRANSACTION READ ONLY;

SELECT c.id AS claim_id,
       c.employee_id,
       c.merchant,
       c.amount,
       c.decided_at AS approved_at,
       r.id AS run_id,
       r.label AS run,
       r.approved_at AS run_approved_at,
       (l.computation -> 'pay' ->> 'nonTaxableAdjustments')::numeric AS run_non_taxable_items,
       row_number() OVER (PARTITION BY c.id ORDER BY r.approved_at) AS nth_run_after_approval
  FROM reimbursement_claims c
  JOIN payroll_run_lines l ON l.employee_id = c.employee_id
  JOIN payroll_runs r ON r.id = l.payroll_run_id AND r.status = 'approved' AND r.approved_at > c.decided_at
 WHERE c.status = 'approved'
   -- Not marked paid yet (paid_at exists only after 018; read this way so the check runs before it too).
   AND to_jsonb(c) ->> 'paid_at' IS NULL
 ORDER BY c.employee_id, c.decided_at, r.approved_at;

ROLLBACK;

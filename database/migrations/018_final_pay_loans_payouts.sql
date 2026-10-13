-- 018: For the website's update of Oct 9 (bef6a17), the parts that were kept only in the browser:
--   * loans: loans and other recurring deductions. Each payroll run deducts the installment until the
--     balance is zero (payroll_adjustments rows marked is_automatic, with loan_id); final pay deducts
--     what's left. The loan number and the note are encrypted by the app (AES-256-GCM).
--   * final_pay_cases: final pay for someone leaving, opened when HR records a separation (the
--     separation itself is employees.separation_date plus a Separation row in job_events). The
--     reason and the release reference are encrypted by the app.
--   * Payout columns on reimbursement_claims: paid with a payroll run, by bank transfer or in final pay.
--     The reference is encrypted by the app.
-- New tables and columns only; nothing is changed or removed. Can only run once (schema_migrations).
--
-- BEFORE applying (and before the next payroll run): until now the server didn't record claim payouts,
-- so approved claims a server payroll run already paid still look unpaid and would be paid again. See
-- which with the read-only check, then (after this migration) mark them paid with the guarded one-off:
--   psql -U postgres -d heyhr -v ON_ERROR_STOP=1 -f database/tools/check-claims-before-018.sql
--   psql -U postgres -d heyhr -v ON_ERROR_STOP=1 -v run=<run id> -v claims=<id>,<id> [-v confirm=yes] -f database/tools/mark-claims-paid.sql
-- Also before restarting the API with this version: anyone whose separation_date has passed becomes
-- Separated and their sign-in is turned off. See who that would be:
--   psql -U postgres -d heyhr -c "select employee_id, record_status, separation_date from employees where separation_date is not null"
--
-- Run as the database owner (postgres):
--   psql -U postgres -d heyhr -v ON_ERROR_STOP=1 -f database/migrations/018_final_pay_loans_payouts.sql

BEGIN;

INSERT INTO schema_migrations (version) VALUES ('018_final_pay_loans_payouts');

-- Loans and other recurring deductions (SSS and Pag-IBIG loans, cash advances, company loans).
CREATE TABLE loans (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id varchar(20) NOT NULL,
  kind text NOT NULL CHECK (kind IN ('SSS salary loan', 'SSS calamity loan', 'Pag-IBIG multi-purpose loan', 'Pag-IBIG calamity loan', 'Cash advance', 'Company loan', 'Other deduction')),
  reference text NOT NULL,
  principal numeric(12,2) NOT NULL,
  installment numeric(12,2) NOT NULL,
  start_date date NOT NULL,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'stopped', 'settled')),
  note text,
  created_by uuid,
  created_by_name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  closed_by uuid,
  closed_by_name text,
  closed_at timestamptz
);

-- Final pay (back pay) for someone leaving: one case each.
CREATE TABLE final_pay_cases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id varchar(20) NOT NULL UNIQUE,
  last_day date NOT NULL,
  reason text NOT NULL,
  opened_by uuid,
  opened_by_name text NOT NULL,
  opened_at timestamptz NOT NULL DEFAULT now(),
  released_by uuid,
  released_by_name text,
  released_at timestamptz,
  release_reference text,
  release_items jsonb,
  release_total numeric(12,2)
);

-- Loan installments and reimbursements that payroll adds by itself.
ALTER TABLE payroll_adjustments
  ADD COLUMN loan_id uuid,
  ADD COLUMN is_automatic boolean NOT NULL DEFAULT false;

-- How an approved claim was paid out.
ALTER TABLE reimbursement_claims
  ADD COLUMN paid_at timestamptz,
  ADD COLUMN paid_by uuid,
  ADD COLUMN paid_by_name text,
  ADD COLUMN payout_method text CHECK (payout_method IN ('payroll', 'transfer', 'final pay')),
  ADD COLUMN payout_reference text;

ALTER TABLE loans ADD CHECK (principal > 0 AND installment > 0 AND installment <= principal);
ALTER TABLE final_pay_cases ADD CHECK (released_at IS NULL OR (release_items IS NOT NULL AND release_total IS NOT NULL));
ALTER TABLE reimbursement_claims ADD CHECK ((paid_at IS NULL) = (payout_method IS NULL));

ALTER TABLE payroll_adjustments ADD CONSTRAINT payroll_adjustments_loan_id_fkey FOREIGN KEY (loan_id) REFERENCES loans (id) ON DELETE SET NULL;
ALTER TABLE loans ADD CONSTRAINT loans_employee_id_fkey FOREIGN KEY (employee_id) REFERENCES employees (employee_id) ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE loans ADD CONSTRAINT loans_created_by_fkey FOREIGN KEY (created_by) REFERENCES user_accounts (id) ON DELETE SET NULL;
ALTER TABLE loans ADD CONSTRAINT loans_closed_by_fkey FOREIGN KEY (closed_by) REFERENCES user_accounts (id) ON DELETE SET NULL;
ALTER TABLE final_pay_cases ADD CONSTRAINT final_pay_cases_employee_id_fkey FOREIGN KEY (employee_id) REFERENCES employees (employee_id) ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE final_pay_cases ADD CONSTRAINT final_pay_cases_opened_by_fkey FOREIGN KEY (opened_by) REFERENCES user_accounts (id) ON DELETE SET NULL;
ALTER TABLE final_pay_cases ADD CONSTRAINT final_pay_cases_released_by_fkey FOREIGN KEY (released_by) REFERENCES user_accounts (id) ON DELETE SET NULL;
ALTER TABLE reimbursement_claims ADD CONSTRAINT reimbursement_claims_paid_by_fkey FOREIGN KEY (paid_by) REFERENCES user_accounts (id) ON DELETE SET NULL;

CREATE INDEX ON final_pay_cases (employee_id);
CREATE INDEX ON final_pay_cases (opened_by);
CREATE INDEX ON final_pay_cases (released_by);
CREATE INDEX ON loans (closed_by);
CREATE INDEX ON loans (created_by);
CREATE INDEX ON loans (employee_id);
CREATE INDEX ON payroll_adjustments (loan_id);
CREATE INDEX ON reimbursement_claims (paid_by);

-- The app's database login (heyhr_app, made by server/setup-db.ps1) can use the new tables.
GRANT SELECT, INSERT, UPDATE, DELETE ON loans, final_pay_cases TO heyhr_app;

COMMENT ON TABLE loans IS 'Loans and other recurring deductions (SSS and Pag-IBIG loans, cash advances, company loans). Each payroll run deducts the installment until the balance is zero; final pay deducts what''s left.';
COMMENT ON COLUMN loans.id IS 'Primary key.';
COMMENT ON COLUMN loans.employee_id IS 'Who repays it.';
COMMENT ON COLUMN loans.kind IS 'Kind of loan or deduction.';
COMMENT ON COLUMN loans.reference IS 'The SSS/Pag-IBIG loan number, or what an Other deduction is for; encrypted by the app (AES-256-GCM).';
COMMENT ON COLUMN loans.principal IS 'The total to deduct.';
COMMENT ON COLUMN loans.installment IS 'Taken from each cutoff''s pay until the balance is zero.';
COMMENT ON COLUMN loans.start_date IS 'First cutoff it''s deducted from (any date inside it).';
COMMENT ON COLUMN loans.status IS 'Running, stopped (no more deductions, e.g. paid outside payroll) or settled (closed in final pay).';
COMMENT ON COLUMN loans.note IS 'Note, or why the deductions stopped; encrypted by the app (AES-256-GCM).';
COMMENT ON COLUMN loans.created_by IS 'Who added it.';
COMMENT ON COLUMN loans.created_by_name IS 'Name of who added it, kept if the account goes.';
COMMENT ON COLUMN loans.created_at IS 'When added.';
COMMENT ON COLUMN loans.closed_by IS 'Who stopped or settled it.';
COMMENT ON COLUMN loans.closed_by_name IS 'Name of who closed it.';
COMMENT ON COLUMN loans.closed_at IS 'When it was stopped or settled.';
COMMENT ON TABLE final_pay_cases IS 'Final pay (back pay) for someone leaving. Opened when HR records a separation or by Accounting; releasing it freezes the figures, settles the loans and pays out approved reimbursements.';
COMMENT ON COLUMN final_pay_cases.id IS 'Primary key.';
COMMENT ON COLUMN final_pay_cases.employee_id IS 'Who is leaving (one case each).';
COMMENT ON COLUMN final_pay_cases.last_day IS 'Their last day.';
COMMENT ON COLUMN final_pay_cases.reason IS 'Why they''re leaving; encrypted by the app (AES-256-GCM).';
COMMENT ON COLUMN final_pay_cases.opened_by IS 'Who opened the case.';
COMMENT ON COLUMN final_pay_cases.opened_by_name IS 'Name of who opened it, kept if the account goes.';
COMMENT ON COLUMN final_pay_cases.opened_at IS 'When opened.';
COMMENT ON COLUMN final_pay_cases.released_by IS 'Who released it.';
COMMENT ON COLUMN final_pay_cases.released_by_name IS 'Name of who released it.';
COMMENT ON COLUMN final_pay_cases.released_at IS 'When released; the figures are frozen as they were then.';
COMMENT ON COLUMN final_pay_cases.release_reference IS 'Check or transfer reference; encrypted by the app (AES-256-GCM).';
COMMENT ON COLUMN final_pay_cases.release_items IS 'The computation as released (a list of {label, detail, amount}; it names loan numbers), encrypted by the app (AES-256-GCM) and stored as one JSON string.';
COMMENT ON COLUMN final_pay_cases.release_total IS 'Final pay as released (negative: the employee owes the difference).';
COMMENT ON COLUMN payroll_adjustments.loan_id IS 'Loan whose installment this is, if any.';
COMMENT ON COLUMN payroll_adjustments.is_automatic IS 'Added by payroll itself (a loan installment or an approved reimbursement), not by hand.';
COMMENT ON COLUMN reimbursement_claims.paid_at IS 'When it was paid out.';
COMMENT ON COLUMN reimbursement_claims.paid_by IS 'Account that recorded the payout.';
COMMENT ON COLUMN reimbursement_claims.paid_by_name IS 'Name of who paid it, kept if the account goes.';
COMMENT ON COLUMN reimbursement_claims.payout_method IS 'How it was paid: with a payroll run, by bank transfer, or in final pay.';
COMMENT ON COLUMN reimbursement_claims.payout_reference IS 'The payroll run, the transfer reference, or Final pay; encrypted by the app (AES-256-GCM).';

COMMIT;

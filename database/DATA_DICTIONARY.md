# HeyHR data dictionary

PostgreSQL schema for the HRIS: 63 tables in 7 areas. The DDL is in [`schema.sql`](schema.sql).

Conventions: `uuid` primary keys; money is `numeric(12,2)` in PHP; times are `timestamptz`; allowed values are enforced with `CHECK`. Computed figures (leave balances, daily attendance results, compliance status) are not stored.

## Company & organization

The firm itself: settings, the branch / department / team tree, and the budgeted positions people are hired into.

### `company_settings`

Single row of company-wide settings: identity, sign-in security, working time and tardiness flags.

| Column | Type | Null | Key | Default | Description |
|---|---|---|---|---|---|
| `id` | smallint | No | PK | `1` | Always 1; the table holds one row. |
| `company_name` | text | No |  |  | Legal or trade name shown on payslips and certificates. |
| `tin` | text | Yes |  |  | Company TIN, 000-000-000-00000. |
| `address` | text | Yes |  |  | Registered business address. |
| `contact_email` | text | Yes |  |  | HR contact address shown to employees. |
| `min_password_length` | smallint | No |  | `8` | Minimum password length for user accounts. |
| `lock_after_failed` | smallint | No |  | `5` | Failed sign-ins before an account locks. |
| `lock_minutes` | smallint | No |  | `15` | How long a locked account stays locked. |
| `idle_minutes` | smallint | No |  | `30` | Idle time before a session signs out. |
| `tardy_consecutive_days` | smallint | No |  | `3` | Flag someone late this many work days in a row (0 = off). |
| `tardy_per_month` | smallint | No |  | `5` | Flag someone late this many times in a month (0 = off). |
| `updated_at` | timestamptz | No |  | `now()` | Last change. |
| `updated_by` | uuid | Yes | FK → user_accounts |  | Account that made the last change. |
| `logo_file_id` | uuid | Yes | FK → files |  | Company logo (Settings > Organization). |
| `default_timezone` | text | No |  | `'Asia/Manila'` | Timezone for anyone who hasn't picked their own. |
| `currency` | text | No |  | `'PHP'` | Currency shown on amounts; payroll is computed in PHP. |
| `work_week` | smallint[] | No |  | `'{1,2,3,4,5}'` | Working days, 0 = Sunday to 6 = Saturday. Leave counts only these days. |
| `work_start` | time | No |  | `'08:30'` | Usual start of the working day. |
| `work_end` | time | No |  | `'17:30'` | Usual end of the working day. |
| `fiscal_year_start_month` | smallint | No |  | `1` | Month the fiscal year starts, 1 = January. |
| `retention_months` | smallint | No |  | `0` | Keep records this many months after separation (0 = keep everything). |
| `leave_half_days` | boolean | No |  | `true` | People may file half a day of leave (Settings > Time off & leave). |
| `leave_negative_balance` | boolean | No |  | `false` | People may file leave beyond their remaining credits. |
| `leave_default_carry_over` | smallint | No |  | `0` | Carry-over limit (days) pre-filled for new leave types. |
| `leave_accrual` | text | No |  | `'yearly'` | How leave credits are granted; only yearly is calculated today. Allowed: `yearly`, `monthly`, `per-payroll`. |
| `overtime_threshold_minutes` | smallint | No |  | `0` | Extra time after a shift shorter than this isn't overtime (Settings > Scheduling). |
| `default_break_minutes` | smallint | No |  | `60` | Lunch break pre-filled for new shifts. |
| `schedule_publish_lead_days` | smallint | No |  | `7` | How many days ahead schedules are published; stored for when there is a publishing step. |
| `payday_first` | smallint | No |  | `10` | First payday of the month: the first cut-off closes and is paid on this day (Payroll > Pay details > Paydays). |
| `payday_second` | smallint | No |  | `25` | Second payday of the month, at least a week after the first; 31 means the last day of the month. |

### `org_units`

The organization tree: one company, its branches, their departments and teams (clusters).

| Column | Type | Null | Key | Default | Description |
|---|---|---|---|---|---|
| `id` | uuid | No | PK | `gen_random_uuid()` | Primary key. |
| `unit_type` | text | No |  |  | Level in the tree. Allowed: `company`, `branch`, `department`, `team`. |
| `name` | text | No |  |  | Display name, e.g. Cebu HQ, Tax Advisory, RPM. |
| `code` | text | No |  |  | Short code used in tables and IDs, e.g. CEB, TAX. |
| `parent_id` | uuid | Yes | FK → org_units |  | Parent unit; null only for the company. |
| `head_employee_id` | varchar(20) | Yes | FK → employees |  | Head of the unit (department head, partner; a branch's manager). |
| `address` | text | Yes |  |  | Street address; branches only. |
| `is_active` | boolean | No |  | `true` | Inactive units stay for history but can't take new people. |
| `contact_name` | text | Yes |  |  | Contact person at the office; branches only. |
| `contact_phone` | text | Yes |  |  | Contact person's phone (PH mobile or landline); branches only. |

### `positions`

Budgeted job positions within a department.

| Column | Type | Null | Key | Default | Description |
|---|---|---|---|---|---|
| `id` | uuid | No | PK | `gen_random_uuid()` | Primary key. |
| `title` | text | No |  |  | Job title, e.g. Experienced Associate. |
| `code` | text | No |  |  | Short code, e.g. EA. |
| `department_id` | uuid | No | FK → org_units |  | Department the position belongs to. |
| `job_level` | text | No |  |  | Seniority band. Allowed: `Rank and file`, `Supervisor`, `Manager`, `Executive`. |
| `default_employment_type` | varchar(12) | No |  | `'PROBATIONARY'` | Type new hires into this position usually start on. Allowed: `PROBATIONARY`, `REGULAR`, `FIXED_TERM`. |
| `budgeted_slots` | smallint | No |  | `1` | Approved headcount for the position. |
| `reports_to_position_id` | uuid | Yes | FK → positions |  | Position this one reports to. |
| `description` | text | Yes |  |  | Duties summary. |
| `is_active` | boolean | No |  | `true` | Inactive positions can't take new hires. |

### `holidays`

Philippine regular and special non-working days, by proclamation.

| Column | Type | Null | Key | Default | Description |
|---|---|---|---|---|---|
| `holiday_date` | date | No | PK |  | The day. |
| `name` | text | No |  |  | e.g. Araw ng Kagitingan. |
| `holiday_type` | text | No |  |  | Regular holidays pay 200%; special days 130%. Allowed: `regular`, `special`. |
| `source` | text | No |  |  | Proclamation number or reference. |

### `holiday_rules`

Holidays HR added on the Holiday calendar, or as company holidays in Settings: proclaimed and local holidays, every year or one year only. The national holidays and the movable ones (Holy Week, National Heroes Day, Chinese New Year) are built into the app.

| Column | Type | Null | Key | Default | Description |
|---|---|---|---|---|---|
| `id` | uuid | No | PK | `gen_random_uuid()` | Primary key. |
| `name` | text | No |  |  | e.g. Eid'l Fitr, Cebu City Charter Day. |
| `holiday_type` | text | No |  |  | Regular holidays pay 200%; special days 130%. Allowed: `regular`, `special`. |
| `repeat_kind` | text | No |  |  | Every year on the same date, or one year only. Allowed: `fixed`, `once`. |
| `repeat_month` | smallint | Yes |  |  | Month (1-12), for a holiday every year. |
| `repeat_day` | smallint | Yes |  |  | Day of the month, for a holiday every year. |
| `once_date` | date | Yes |  |  | The date, for a one-year holiday. |
| `source` | text | No |  |  | Proclamation or ordinance; Company for company holidays added in Settings. |
| `created_by` | uuid | Yes | FK → user_accounts |  | Who added it. |
| `created_by_name` | text | No |  |  | Name of who added it, kept if the account goes. |
| `created_at` | timestamptz | No |  | `now()` | When the row was created. |

### `holiday_rule_branches`

Offices a local holiday applies to. No rows means every office.

| Column | Type | Null | Key | Default | Description |
|---|---|---|---|---|---|
| `holiday_rule_id` | uuid | No | PK, FK → holiday_rules |  | The holiday. |
| `branch_id` | uuid | No | PK, FK → org_units |  | Office it applies to. |

### `holiday_changes`

One-year changes from a proclamation: a holiday moved to another date, or cancelled, that year.

| Column | Type | Null | Key | Default | Description |
|---|---|---|---|---|---|
| `id` | uuid | No | PK | `gen_random_uuid()` | Primary key. |
| `builtin_rule_id` | text | Yes |  |  | Built-in holiday it changes (the app's id, e.g. national-heroes-day). |
| `holiday_rule_id` | uuid | Yes | FK → holiday_rules |  | Holiday HR added that it changes. |
| `year` | smallint | No |  |  | The year it applies to. |
| `change_kind` | text | No |  |  | Moved or cancelled that year. Allowed: `move`, `cancel`. |
| `new_date` | date | Yes |  |  | The new date, when moved. |
| `source` | text | No |  |  | Proclamation that changes it. |
| `changed_by` | uuid | Yes | FK → user_accounts |  | Who recorded it. |
| `changed_by_name` | text | No |  |  | Name of who recorded it, kept if the account goes. |
| `changed_at` | timestamptz | No |  | `now()` | When it was recorded. |

## People & 201 File

The employee master record and everything kept in the 201 File: dependents, documents, job history, licenses, benefits and separation.

### `employees`

The employee master record (201 File core). Fields marked BRD follow the New Employees Template (BRD v1.1, 11.2.1). Government numbers and BASIC_RATE are HR- and Payroll-only.

| Column | Type | Null | Key | Default | Description |
|---|---|---|---|---|---|
| `employee_id` | varchar(20) | No | PK | `'MSMA-' || lpad(nextval('employee_id_seq')::text, 5, '0')` | BRD. Unique employee identifier. Auto-generated if blank (MSMA-00001). |
| `last_name` | varchar(50) | No |  |  | BRD. Surname. Letters only (spaces, hyphens, apostrophes, periods allowed). |
| `first_name` | varchar(50) | No |  |  | BRD. Given name. Letters only. |
| `middle_name` | varchar(50) | Yes |  |  | BRD. Middle name. Letters only. |
| `suffix` | varchar(10) | Yes |  |  | Jr., Sr., III. |
| `birth_date` | date | Yes |  |  | BRD. Date of birth. Age must be 18 or older (checked by trigger). Blank until filled in for a record made by Add user. |
| `sex` | char(1) | Yes |  |  | BRD. Gender. From the allowed values only. Blank until filled in for a record made by Add user. Allowed: `M`, `F`. |
| `civil_status` | varchar(10) | Yes |  |  | BRD. Marital status. From the allowed values only. Blank until filled in for a record made by Add user. Allowed: `SINGLE`, `MARRIED`, `WIDOWED`, `SEPARATED`. |
| `mobile_no` | varchar(11) | Yes | UQ |  | BRD. Mobile number, 11 digits: 09XXXXXXXXX. Unique. Blank until filled in for a record made by Add user. |
| `email` | varchar(100) | Yes | UQ |  | BRD. Email address (work). Valid email format. Unique. Blank until filled in for a record made by Add user. |
| `date_hired` | date | Yes |  |  | BRD. First day of employment. Not more than 30 days in the future (checked by trigger). Blank until filled in for a record made by Add user (leave earned by the month and service-based leave wait for it). |
| `employment_status` | varchar(12) | No |  | `'PROBATIONARY'` | BRD. Employment type. Allowed: `PROBATIONARY`, `REGULAR`, `FIXED_TERM`. |
| `tin` | text | Yes |  |  | BRD. Tax Identification Number, encrypted by the app (AES-256-GCM). Required before first payroll. |
| `sss_no` | text | Yes |  |  | BRD. SSS number, encrypted by the app (AES-256-GCM). Required before first payroll. |
| `philhealth_no` | text | Yes |  |  | BRD. PhilHealth number, encrypted by the app (AES-256-GCM). Required before first payroll. |
| `pagibig_no` | text | Yes |  |  | BRD. Pag-IBIG MID number, encrypted by the app (AES-256-GCM). Required before first payroll. |
| `tin_hash` | text | Yes | UQ |  | Fingerprint of the TIN (HMAC-SHA256), so no two employees share one. |
| `sss_no_hash` | text | Yes | UQ |  | Fingerprint of the SSS number (HMAC-SHA256), so no two employees share one. |
| `philhealth_no_hash` | text | Yes | UQ |  | Fingerprint of the PhilHealth number (HMAC-SHA256), so no two employees share one. |
| `pagibig_no_hash` | text | Yes | UQ |  | Fingerprint of the Pag-IBIG MID (HMAC-SHA256), so no two employees share one. |
| `bank_name` | text | Yes |  |  | Bank (or e-wallet) take-home pay is sent to. |
| `bank_account_name` | text | Yes |  |  | Name on the account. |
| `bank_account_no` | text | Yes |  |  | Account number, encrypted by the app (AES-256-GCM). |
| `basic_rate` | numeric(12,2) | Yes |  |  | BRD. Basic monthly salary in PHP; must be > 0. Restricted to HR and Payroll. Blank until filled in for a record made by Add user; payroll runs and final pay leave the person out until then. |
| `nationality` | varchar(50) | No |  | `'Filipino'` | Nationality. |
| `photo_file_id` | uuid | Yes | FK → files |  | ID photo. |
| `personal_email` | varchar(100) | Yes |  |  | Personal email. |
| `address_line` | text | Yes |  |  | House no., street, barangay. |
| `city` | varchar(100) | Yes |  |  | City or municipality. |
| `province` | varchar(100) | Yes |  |  | Province. |
| `emergency_name` | varchar(100) | Yes |  |  | Emergency contact person. |
| `emergency_relationship` | varchar(50) | Yes |  |  | Their relationship to the employee. |
| `emergency_phone` | varchar(20) | Yes |  |  | Their phone number. |
| `position_id` | uuid | Yes | FK → positions |  | Current position. |
| `org_unit_id` | uuid | Yes | FK → org_units |  | Team, or the department when not in a team. |
| `supervisor_id` | varchar(20) | Yes | FK → employees |  | Immediate supervisor. |
| `record_status` | varchar(10) | No |  | `'ACTIVE'` | Whether the person is currently working here. Allowed: `ACTIVE`, `ON_LEAVE`, `SUSPENDED`, `SEPARATED`. |
| `regularization_date` | date | Yes |  |  | When the employee became REGULAR. |
| `separation_date` | date | Yes |  |  | Last day, once separated. |
| `work_schedule` | text | Yes |  |  | Schedule as shown on the 201 File, e.g. Mon-Fri, 8:30 AM - 5:00 PM. |
| `default_shift_id` | varchar(20) | Yes | FK → shift_templates |  | Usual shift; overridden per day in schedule_overrides. |
| `face_enrolled` | boolean | No |  | `false` | Face template enrolled for face-scan clock-in. |
| `created_at` | timestamptz | No |  | `now()` | When the row was created. |
| `updated_at` | timestamptz | No |  | `now()` | Last change. |

### `dependents`

Spouse and children, for HMO enrollment and leave eligibility.

| Column | Type | Null | Key | Default | Description |
|---|---|---|---|---|---|
| `id` | uuid | No | PK | `gen_random_uuid()` | Primary key. |
| `employee_id` | varchar(20) | No | FK → employees |  | The employee this belongs to. |
| `full_name` | text | No |  |  | Dependent's name. |
| `relationship` | text | No |  |  | Relationship. Allowed: `Spouse`, `Child`. |
| `birth_date` | date | Yes |  |  | Birth date (children). |
| `hmo_enrolled` | boolean | No |  | `false` | Enrolled as an HMO dependent. |

### `files`

Uploaded files: documents, receipts, photos. Kept in `content` for now; object storage later.

| Column | Type | Null | Key | Default | Description |
|---|---|---|---|---|---|
| `id` | uuid | No | PK | `gen_random_uuid()` | Primary key. |
| `storage_key` | text | No | UQ |  | Object-storage key. |
| `file_name` | text | No |  |  | Original file name, encrypted by the app (AES-256-GCM). |
| `content_type` | text | No |  |  | MIME type. |
| `size_bytes` | bigint | No |  |  | File size. |
| `sha256` | text | Yes |  |  | Checksum, to catch duplicates. |
| `content` | bytea | Yes |  |  | The file itself, encrypted by the app (AES-256-GCM), while files are kept in the database (null once moved to object storage). |
| `uploaded_by` | uuid | Yes | FK → user_accounts |  | Account that uploaded it. |
| `uploaded_at` | timestamptz | No |  | `now()` | Upload time. |

### `employee_documents`

Pre-employment and identity documents in the 201 File checklist.

| Column | Type | Null | Key | Default | Description |
|---|---|---|---|---|---|
| `id` | uuid | No | PK | `gen_random_uuid()` | Primary key. |
| `employee_id` | varchar(20) | No | FK → employees |  | The employee this belongs to. |
| `document_type` | text | No |  |  | Checklist item. Allowed: `Application Form / Resume`, `Birth Certificate (PSA)`, `Marriage Certificate (PSA)`, `Child's Birth Certificate`, `Valid Government ID`, `Diploma / Transcript of Records`, `Professional License`, `Certificate of Employment (Previous)`, `NBI Clearance`, `Police/Barangay Clearance`, `Pre-Employment Medical Result`. |
| `status` | text | No |  | `'Missing'` | Where it stands. Allowed: `Missing`, `Submitted`, `Verified`, `Not applicable`. |
| `file_id` | uuid | Yes | FK → files |  | The uploaded scan. |
| `file_name` | text | Yes |  |  | Name of the submitted file, encrypted by the app (AES-256-GCM). |
| `submitted_at` | timestamptz | Yes |  |  | When it was uploaded. |
| `verified_by` | uuid | Yes | FK → user_accounts |  | HR account that verified it. |
| `verified_by_name` | text | Yes |  |  | Name of who verified it, kept if the account goes. |
| `verified_at` | timestamptz | Yes |  |  | When it was verified. |
| `id_type` | text | Yes |  |  | For government IDs: UMID, Passport, Driver's License… |
| `reference_no` | text | Yes |  |  | ID or license number, encrypted by the app (AES-256-GCM). |
| `expires_on` | date | Yes |  |  | Expiry of the ID, license or clearance; drives renewal alerts. |
| `note` | text | Yes |  |  | HR note. |

### `job_events`

Employment history: hires, promotions, transfers, salary changes, separations.

| Column | Type | Null | Key | Default | Description |
|---|---|---|---|---|---|
| `id` | uuid | No | PK | `gen_random_uuid()` | Primary key. |
| `employee_id` | varchar(20) | No | FK → employees |  | The employee this belongs to. |
| `event_kind` | text | No |  |  | What happened. Allowed: `Hired`, `Promotion`, `Transfer`, `Salary adjustment`, `Regularization`, `Supervisor change`, `Status change`, `Separation`. |
| `effective_date` | date | No |  |  | When it takes effect. |
| `changes` | jsonb | No |  | `'[]'` | List of {label, from, to} field changes. |
| `remarks` | text | Yes |  |  | Personnel action notice number or remarks. |
| `recorded_by` | uuid | Yes | FK → user_accounts |  | Account that recorded it. |
| `recorded_by_name` | text | No |  |  | Name of who recorded it, kept if the account goes. |
| `recorded_at` | timestamptz | No |  | `now()` | When it was recorded. |

### `professional_licenses`

PRC licenses (CPA, lawyer) and CPD unit progress.

| Column | Type | Null | Key | Default | Description |
|---|---|---|---|---|---|
| `id` | uuid | No | PK | `gen_random_uuid()` | Primary key. |
| `employee_id` | varchar(20) | No | FK → employees |  | The employee this belongs to. |
| `license_type` | text | No |  |  | e.g. CPA. |
| `license_number` | text | No |  |  | PRC license number, encrypted by the app (AES-256-GCM). |
| `expires_on` | date | Yes |  |  | License validity. |
| `cpd_units_earned` | numeric(5,1) | No |  | `0` | CPD units earned this cycle. |
| `cpd_units_required` | numeric(5,1) | No |  | `60` | CPD units required for renewal. |
| `cycle_end_date` | date | Yes |  |  | End of the current CPD compliance cycle. |

### `employee_benefits`

HMO and government benefit memberships.

| Column | Type | Null | Key | Default | Description |
|---|---|---|---|---|---|
| `id` | uuid | No | PK | `gen_random_uuid()` | Primary key. |
| `employee_id` | varchar(20) | No | FK → employees |  | The employee this belongs to. |
| `benefit_name` | text | No |  |  | e.g. HMO, HMO — Dependent. |
| `provider` | text | No |  |  | e.g. Maxicare. |
| `member_no` | text | Yes |  |  | Membership or card number. |
| `status` | text | No |  |  | Enrollment status. Allowed: `Active`, `Pending`, `Not enrolled`. |

### `performance_reviews`

Appraisals, annual and mid-year.

| Column | Type | Null | Key | Default | Description |
|---|---|---|---|---|---|
| `id` | uuid | No | PK | `gen_random_uuid()` | Primary key. |
| `employee_id` | varchar(20) | No | FK → employees |  | The employee this belongs to. |
| `review_period` | text | No |  |  | e.g. 2026 Mid-year review. |
| `reviewer_id` | varchar(20) | Yes | FK → employees |  | Who reviewed. |
| `rating` | numeric(3,1) | Yes |  |  | Score out of 5. |
| `status` | text | No |  | `'Pending'` | Review status. Allowed: `Pending`, `Submitted`, `Completed`. |
| `completed_at` | timestamptz | Yes |  |  | When it was completed. |

### `training_records`

Assigned trainings and their progress.

| Column | Type | Null | Key | Default | Description |
|---|---|---|---|---|---|
| `id` | uuid | No | PK | `gen_random_uuid()` | Primary key. |
| `employee_id` | varchar(20) | No | FK → employees |  | The employee this belongs to. |
| `course` | text | No |  |  | Course name. |
| `due_date` | date | Yes |  |  | Deadline. |
| `status` | text | No |  | `'Not started'` | Progress. Allowed: `Not started`, `In progress`, `Completed`. |
| `completed_on` | date | Yes |  |  | Completion date. |

### `employee_cases`

Employee relations cases a partner or HR files.

| Column | Type | Null | Key | Default | Description |
|---|---|---|---|---|---|
| `id` | uuid | No | PK | `gen_random_uuid()` | Primary key. |
| `employee_id` | varchar(20) | No | FK → employees |  | The employee this belongs to. |
| `case_type` | text | No |  |  | Kind of case. Allowed: `Attendance`, `Conduct`, `Performance`, `Grievance`. |
| `status` | text | No |  | `'Open'` | Case status. Allowed: `Open`, `Under review`, `Resolved`. |
| `summary` | text | No |  |  | What happened and what was done, encrypted by the app (AES-256-GCM). |
| `filed_by` | uuid | No | FK → user_accounts |  | Account that filed it. |
| `filed_on` | date | No |  | `current_date` | Filing date. |

### `company_assets`

Laptops, IDs, access cards and phones issued to employees.

| Column | Type | Null | Key | Default | Description |
|---|---|---|---|---|---|
| `id` | uuid | No | PK | `gen_random_uuid()` | Primary key. |
| `asset_tag` | text | No | UQ |  | Inventory tag, e.g. LT-0231. |
| `asset_type` | text | No |  |  | e.g. Laptop, Company ID, Access Card. |
| `assigned_employee_id` | varchar(20) | Yes | FK → employees |  | Who has it now. |
| `issued_on` | date | Yes |  |  | Issue date. |
| `returned_on` | date | Yes |  |  | Return date. |
| `status` | text | No |  | `'Issued'` | Condition. Allowed: `Issued`, `Returned`, `Under repair`. |

### `offboarding_cases`

Resignations and separations with clearance progress.

| Column | Type | Null | Key | Default | Description |
|---|---|---|---|---|---|
| `id` | uuid | No | PK | `gen_random_uuid()` | Primary key. |
| `employee_id` | varchar(20) | No | FK → employees |  | The employee this belongs to. |
| `separation_type` | text | No |  |  | e.g. Voluntary resignation. |
| `reason` | text | Yes |  |  | Stated reason, encrypted by the app (AES-256-GCM). |
| `notice_filed_on` | date | Yes |  |  | When notice was given (30-day rule). |
| `last_day` | date | No |  |  | Last working day. |
| `stage` | text | No |  | `'Resignation filed'` | Where it stands. Allowed: `Resignation filed`, `Clearance in progress`, `Final pay released`. |
| `clearance` | jsonb | No |  | `'[]'` | List of {department, status} clearance sign-offs. |

### `certificate_requests`

COE and other certificates employees request.

| Column | Type | Null | Key | Default | Description |
|---|---|---|---|---|---|
| `id` | uuid | No | PK | `gen_random_uuid()` | Primary key. |
| `employee_id` | varchar(20) | No | FK → employees |  | The employee this belongs to. |
| `certificate_type` | text | No |  |  | e.g. Certificate of Employment. |
| `purpose` | text | No |  |  | e.g. Bank loan application. |
| `status` | text | No |  | `'Pending'` | Status. Allowed: `Pending`, `Ready for pickup`, `Released`. |
| `requested_at` | timestamptz | No |  | `now()` | Request time. |
| `released_at` | timestamptz | Yes |  |  | Release time. |
| `delivery` | text | Yes |  |  | How it reached the employee: a digital copy to download, or a signed copy picked up from HR. Allowed: `digital`, `pickup`. |
| `handled_by` | uuid | Yes | FK → user_accounts |  | HR account that took the last step (issued, ready for pickup, released, declined). |
| `handled_by_name` | text | Yes |  |  | Name of who took the last step, kept if the account goes. |
| `handled_at` | timestamptz | Yes |  |  | When the last step was taken. |
| `decline_reason` | text | Yes |  |  | Why HR declined it, shown to the employee; encrypted by the app (AES-256-GCM). When set the request is declined (shown as Declined; status stays Pending). |
| `certificate_no` | text | Yes | UQ |  | Number of the issued certificate, e.g. COE-2026-0001 (per type and year). |
| `issued_statement` | text | Yes |  |  | The certificate's exact wording when issued, made from the employee's record at that time (HR's filed copy and the employee's download); encrypted by the app (AES-256-GCM). |
| `issued_purpose` | text | Yes |  |  | Purpose printed on the issued certificate. |
| `issued_at` | timestamptz | Yes |  |  | When it was issued. |
| `issued_by` | uuid | Yes | FK → user_accounts |  | HR account that issued it. |
| `issued_by_name` | text | Yes |  |  | Name of who issued it, kept if the account goes. |

## Timekeeping & attendance

Shifts, schedules, punches from biometric and face devices, and the requests that adjust them. Daily results (late, undertime, overtime) are computed from these, not stored.

### `shift_templates`

Work shifts: Busy season, Peak season, Mid shift, Flexible time.

| Column | Type | Null | Key | Default | Description |
|---|---|---|---|---|---|
| `id` | varchar(20) | No | PK |  | Short key, e.g. sh-day; new shifts get sh-… |
| `name` | text | No | UQ |  | Shift name. |
| `start_time` | time | No |  |  | Start, local time. |
| `end_time` | time | No |  |  | End; earlier than start means it ends next day. |
| `break_minutes` | smallint | No |  | `60` | Unpaid break length. |
| `break_start` | time | No |  |  | When lunch starts; lunch out/in are recorded from it. |
| `grace_minutes` | smallint | No |  | `5` | Minutes after start before someone is late. |
| `rest_days` | smallint[] | No |  | `'{0,6}'` | Days off, 0 = Sunday. |
| `is_flexible` | boolean | No |  | `false` | Clock in any time in the window; only hours worked count. |
| `required_hours` | numeric(4,2) | Yes |  |  | Hours a flexible day needs. |
| `is_active` | boolean | No |  | `true` | Retired shifts stay for history. |
| `saturday_end` | time | Yes |  |  | When Saturday ends on a six-day week (a shorter day, no break); empty = Saturday ends at end_time. |

### `schedule_overrides`

A different shift, or a rest day, for one person on one date.

| Column | Type | Null | Key | Default | Description |
|---|---|---|---|---|---|
| `employee_id` | varchar(20) | No | PK, FK → employees |  | The employee. |
| `work_date` | date | No | PK |  | The date. |
| `shift_id` | varchar(20) | Yes | FK → shift_templates |  | Shift that day; null means a rest day. |
| `set_by` | uuid | Yes | FK → user_accounts |  | Account that set it. |

### `attendance_devices`

Registered biometric scanners and face kiosks.

| Column | Type | Null | Key | Default | Description |
|---|---|---|---|---|---|
| `id` | uuid | No | PK | `gen_random_uuid()` | Primary key. |
| `name` | text | No |  |  | e.g. Cebu HQ lobby, 8F. |
| `device_type` | text | No |  |  | Kind of device. Allowed: `biometric`, `face`. |
| `branch_id` | uuid | No | FK → org_units |  | Branch it's installed in. |
| `serial_no` | text | Yes | UQ |  | Hardware serial. |
| `is_registered` | boolean | No |  | `true` | Punches from unregistered devices get flagged. |

### `punches`

Every time-in and time-out. Never deleted; HR sets bad ones aside.

| Column | Type | Null | Key | Default | Description |
|---|---|---|---|---|---|
| `id` | uuid | No | PK | `gen_random_uuid()` | Primary key. |
| `employee_id` | varchar(20) | No | FK → employees |  | The employee this belongs to. |
| `work_date` | date | No |  |  | Schedule day it belongs to (an overnight shift's 6 AM out counts for the day before). |
| `punched_at` | timestamptz | No |  |  | The moment of the punch. |
| `direction` | text | No |  |  | Time-in or time-out. Allowed: `in`, `out`. |
| `source` | text | No |  |  | Where it came from. Allowed: `biometric`, `face`, `manual`, `remote`. |
| `device_id` | uuid | Yes | FK → attendance_devices |  | Device that recorded it. |
| `device_label` | text | Yes |  |  | Where it came from as shown on the record, e.g. Added by HR, Remote · face scan. |
| `device_branch` | text | Yes |  |  | Branch of the device (or of the person, for manual punches). |
| `face_match` | smallint | Yes |  |  | Face recognition match, 0–100. |
| `reason` | text | Yes |  |  | Why HR added it (manual punches), or the remote work day's reason. |
| `recorded_by` | uuid | Yes | FK → user_accounts |  | Account that added a manual or remote punch. |
| `recorded_by_name` | text | Yes |  |  | Name of who recorded it. |
| `voided_reason` | text | Yes |  |  | Why HR set it aside. |
| `voided_by` | uuid | Yes | FK → user_accounts |  | Who set it aside. |
| `voided_by_name` | text | Yes |  |  | Name of who set it aside. |
| `voided_at` | timestamptz | Yes |  |  | When. |
| `confirmed_by` | uuid | Yes | FK → user_accounts |  | HR looked at a flagged punch and kept it. |
| `confirmed_by_name` | text | Yes |  |  | Name of who kept it. |
| `confirmed_at` | timestamptz | Yes |  |  | When. |
| `location` | text | Yes |  |  | Where a clock-in from home was made (the phone's GPS: latitude, longitude, accuracy in metres) or why it couldn't be had, as JSON encrypted by the app (AES-256-GCM). Only HR, the person's approver and the person may read it. |

### `time_requests`

Overtime and undertime requests.

| Column | Type | Null | Key | Default | Description |
|---|---|---|---|---|---|
| `id` | uuid | No | PK | `gen_random_uuid()` | Primary key. |
| `employee_id` | varchar(20) | No | FK → employees |  | The employee this belongs to. |
| `work_date` | date | No |  |  | The day. |
| `request_type` | text | No |  |  | Kind. Allowed: `overtime`, `undertime`. |
| `minutes` | smallint | No |  |  | Minutes requested. |
| `reason` | text | No |  |  | Why. |
| `status` | text | No |  | `'pending'` | Status. Allowed: `pending`, `approved`, `declined`. |
| `filed_by_name` | text | No |  |  | Name of who filed it. |
| `filed_at` | timestamptz | No |  | `now()` | When filed. |
| `decided_by` | uuid | Yes | FK → user_accounts |  | Account that approved or declined it. |
| `decided_by_name` | text | Yes |  |  | Name of who decided, kept if the account goes. |
| `decided_at` | timestamptz | Yes |  |  | When it was decided. |
| `decision_note` | text | Yes |  |  | Note from the approver to the employee. |
| `start_at` | timestamptz | Yes |  |  | When the overtime or undertime starts; minutes = end_at - start_at. Empty for requests filed before 030. |
| `end_at` | timestamptz | Yes |  |  | When it ends (can be the next day). |

### `punch_fix_requests`

Employee asks HR to add or correct a time-in/out the device missed.

| Column | Type | Null | Key | Default | Description |
|---|---|---|---|---|---|
| `id` | uuid | No | PK | `gen_random_uuid()` | Primary key. |
| `employee_id` | varchar(20) | No | FK → employees |  | The employee this belongs to. |
| `work_date` | date | No |  |  | The day. |
| `direction` | text | No |  |  | Which punch. Allowed: `in`, `out`. |
| `requested_time` | time | No |  |  | Correct time. |
| `next_day` | boolean | No |  | `false` | Time falls on the next calendar day. |
| `cause` | text | No |  | `'not-recorded'` | What went wrong. Allowed: `not-recorded`, `wrong-time`, `system-error`, `other`. |
| `recorded_time` | time | Yes |  |  | Time on record when the request was sent. |
| `reason` | text | No |  |  | Explanation. |
| `status` | text | No |  | `'pending'` | Status. Allowed: `pending`, `approved`, `declined`. |
| `filed_by_name` | text | No |  |  | Name of who filed it. |
| `filed_at` | timestamptz | No |  | `now()` | When filed. |
| `decided_by` | uuid | Yes | FK → user_accounts |  | Account that approved or declined it. |
| `decided_by_name` | text | Yes |  |  | Name of who decided, kept if the account goes. |
| `decided_at` | timestamptz | Yes |  |  | When it was decided. |
| `decision_note` | text | Yes |  |  | Note from the approver to the employee. |

### `work_from_home_days`

Days an employee switched to working from home themselves (their manager is told). They clock in with a face scan.

| Column | Type | Null | Key | Default | Description |
|---|---|---|---|---|---|
| `employee_id` | varchar(20) | No | PK, FK → employees |  | Who works from home. |
| `work_date` | date | No | PK |  | The day. |
| `declared_at` | timestamptz | No |  | `now()` | When they switched. |

### `remote_work_days`

Work-from-home days HR declares for typhoons and emergencies.

| Column | Type | Null | Key | Default | Description |
|---|---|---|---|---|---|
| `id` | uuid | No | PK | `gen_random_uuid()` | Primary key. |
| `date_from` | date | No |  |  | First day. |
| `date_to` | date | No |  |  | Last day. |
| `reason` | text | No |  |  | e.g. Typhoon signal no. 3. |
| `declared_by` | uuid | No | FK → user_accounts |  | Who declared it. |
| `declared_by_name` | text | No |  |  | Name of who declared it. |
| `declared_at` | timestamptz | No |  | `now()` | When. |

### `remote_work_day_branches`

Branches a remote work day covers. No rows means every branch.

| Column | Type | Null | Key | Default | Description |
|---|---|---|---|---|---|
| `remote_work_day_id` | uuid | No | PK, FK → remote_work_days |  | The remote work day. |
| `branch_id` | uuid | No | PK, FK → org_units |  | Branch covered. |

### `attendance_notices`

Memos HR sends about repeated lateness or AWOL. Never change pay.

| Column | Type | Null | Key | Default | Description |
|---|---|---|---|---|---|
| `id` | uuid | No | PK | `gen_random_uuid()` | Primary key. |
| `employee_id` | varchar(20) | No | FK → employees |  | The employee this belongs to. |
| `notice_kind` | text | No |  |  | Kind. Allowed: `tardiness`, `awol`. |
| `subject` | text | No |  |  | Subject line. |
| `message` | text | No |  |  | Body. |
| `dates` | date[] | No |  |  | The days it's about. |
| `sent_by` | uuid | No | FK → user_accounts |  | Sender. |
| `sent_by_name` | text | No |  |  | Name of the sender. |
| `sent_at` | timestamptz | No |  | `now()` | When sent. |
| `acknowledged_at` | timestamptz | Yes |  |  | When the employee acknowledged it. |

### `premium_rates`

Statutory premium multipliers by kind of day, versioned by effective date.

| Column | Type | Null | Key | Default | Description |
|---|---|---|---|---|---|
| `day_type` | text | No | PK |  | Kind of day. Allowed: `ordinary`, `rest`, `special`, `regular`, `special-rest`, `regular-rest`. |
| `effective_from` | date | No | PK |  | First day these rates apply. |
| `first_eight_hours` | numeric(4,2) | No |  |  | Multiplier for the first 8 hours, e.g. 1.30. |
| `overtime` | numeric(4,2) | No |  |  | Multiplier for overtime hours, e.g. 1.69. |
| `source` | text | No |  |  | Labor Code article or DOLE advisory. |
| `last_verified` | date | No |  |  | When someone last checked it against the source. |

## Leave

Leave types and their rules, requests, manual adjustments and carry-over. Balances are always computed from these, never stored.

### `leave_types`

Company and statutory leave types (VL, SL, maternity, solo parent…).

| Column | Type | Null | Key | Default | Description |
|---|---|---|---|---|---|
| `id` | varchar(20) | No | PK |  | Short key, e.g. vl, ml; new types get lt-… |
| `name` | text | No | UQ |  | e.g. Vacation leave. |
| `code` | text | No | UQ |  | e.g. VL. |
| `days_per_year` | numeric(5,2) | No |  |  | Days a year, or per event for statutory leave; 0 = unlimited. |
| `earning_kind` | text | No |  |  | How days are earned. Allowed: `monthly`, `yearly`, `per-event`, `unlimited`. |
| `earning_per_month` | numeric(4,2) | Yes |  |  | Days earned each month, for monthly accrual. |
| `is_paid` | boolean | No |  | `true` | Unpaid leave is deducted in payroll. |
| `carry_over_max` | numeric(5,2) | No |  | `0` | Unused days that roll into next year. |
| `count_by` | text | No |  | `'workdays'` | Skip rest days and holidays, or count every day. Allowed: `workdays`, `calendar`. |
| `eligibility` | text | No |  | `'everyone'` | Who can use it. Allowed: `everyone`, `female`, `male-married`, `solo-parent`, `after-1-year`, `after-6-months`. |
| `attachment_over_days` | numeric(5,2) | Yes |  |  | Attachment required past this many days; null = never. |
| `is_confidential` | boolean | No |  | `false` | Reason hidden from all but HR (VAWC). |
| `legal_basis` | text | No |  |  | Law or policy it comes from. |
| `is_active` | boolean | No |  | `true` | Active. |

### `leave_requests`

Leave filed by or for an employee.

| Column | Type | Null | Key | Default | Description |
|---|---|---|---|---|---|
| `id` | uuid | No | PK | `gen_random_uuid()` | Primary key. |
| `employee_id` | varchar(20) | No | FK → employees |  | The employee this belongs to. |
| `leave_type_id` | varchar(20) | No | FK → leave_types |  | Type of leave. |
| `date_from` | date | No |  |  | First day. |
| `date_to` | date | No |  |  | Last day. |
| `half_day` | text | Yes |  |  | Half day, only when the dates are equal. Allowed: `am`, `pm`. |
| `days` | numeric(5,2) | No |  |  | Days charged, after skipping rest days and holidays. |
| `reason` | text | No |  |  | Reason, encrypted by the app (AES-256-GCM): it can describe an illness. |
| `attachment_file_id` | uuid | Yes | FK → files |  | Medical certificate or other proof. |
| `attachment_name` | text | Yes |  |  | Name of the attached file, encrypted by the app (AES-256-GCM). |
| `status` | text | No |  | `'pending'` | Status. Allowed: `pending`, `approved`, `rejected`, `cancelled`. |
| `filed_by` | uuid | No | FK → user_accounts |  | Account that filed it (the employee or HR). |
| `filed_by_name` | text | No |  |  | Name of who filed it. |
| `filed_at` | timestamptz | No |  | `now()` | When filed. |
| `decided_by` | uuid | Yes | FK → user_accounts |  | Account that approved or declined it. |
| `decided_by_name` | text | Yes |  |  | Name of who decided, kept if the account goes. |
| `decided_at` | timestamptz | Yes |  |  | When it was decided. |
| `decision_note` | text | Yes |  |  | Note from the approver to the employee. |

### `leave_adjustments`

Manual changes HR makes to a balance or to the yearly leave credits.

| Column | Type | Null | Key | Default | Description |
|---|---|---|---|---|---|
| `id` | uuid | No | PK | `gen_random_uuid()` | Primary key. |
| `employee_id` | varchar(20) | No | FK → employees |  | The employee this belongs to. |
| `leave_type_id` | varchar(20) | Yes | FK → leave_types |  | Type of leave; null means the yearly credit pool (6 leaves a year). |
| `days` | numeric(5,2) | No |  |  | Positive adds, negative removes (days, or whole leaves for the credit pool). |
| `reason` | text | No |  |  | Why. |
| `adjusted_by` | uuid | No | FK → user_accounts |  | Who made it. |
| `adjusted_by_name` | text | No |  |  | Name of who made it. |
| `adjusted_at` | timestamptz | No |  | `now()` | When. |

### `leave_carry_overs`

Unused days brought into a year.

| Column | Type | Null | Key | Default | Description |
|---|---|---|---|---|---|
| `employee_id` | varchar(20) | No | PK, FK → employees |  | The employee. |
| `leave_type_id` | varchar(20) | No | PK, FK → leave_types |  | Type of leave. |
| `leave_year` | smallint | No | PK |  | Year the days are carried into. |
| `days` | numeric(5,2) | No |  |  | Days carried over. |

## Payroll & reimbursements

Contribution rate versions, payroll runs frozen from attendance once approved, adjustments, and expense claims. An employee's payslip is their line in an approved run.

### `contribution_rate_versions`

SSS, PhilHealth, Pag-IBIG and BIR tables. A new circular is a new row, so past pay can still be recomputed.

| Column | Type | Null | Key | Default | Description |
|---|---|---|---|---|---|
| `id` | uuid | No | PK | `gen_random_uuid()` | Primary key. |
| `agency` | text | No |  |  | Agency. Allowed: `sss`, `philhealth`, `pagibig`, `bir`. |
| `effective_from` | date | No |  |  | First pay date the rates apply to. |
| `source` | text | No |  |  | Circular or schedule it comes from. |
| `rates` | jsonb | No |  |  | Rates in the agency's shape (EE/ER rates, MSC range, tax brackets). |
| `saved_by` | uuid | Yes | FK → user_accounts |  | Who saved this version. |
| `saved_by_name` | text | No |  |  | Name of who saved it (Built in for the starting tables). |
| `saved_at` | timestamptz | No |  | `now()` | When. |

### `payroll_runs`

One payroll per cutoff. Draft runs recompute from attendance; approved runs are locked.

| Column | Type | Null | Key | Default | Description |
|---|---|---|---|---|---|
| `id` | uuid | No | PK | `gen_random_uuid()` | Primary key. |
| `label` | text | No |  |  | e.g. Oct 1–15, 2026. |
| `period_from` | date | No |  |  | Cutoff start. |
| `period_to` | date | No |  |  | Cutoff end. |
| `branch_id` | uuid | Yes | FK → org_units |  | Branch, when run per office; null = all. |
| `status` | text | No |  | `'draft'` | Status. Allowed: `draft`, `approved`. |
| `created_by` | uuid | No | FK → user_accounts |  | Who started it. |
| `created_by_name` | text | No |  |  | Name of who started it. |
| `created_at` | timestamptz | No |  | `now()` | When. |
| `computed_at` | timestamptz | No |  | `now()` | Last recompute from attendance. |
| `approved_by` | uuid | Yes | FK → user_accounts |  | Who approved it (the CEO). |
| `approved_by_name` | text | Yes |  |  | Name of who approved it. |
| `approved_at` | timestamptz | Yes |  |  | When approved. |
| `payslips_released_at` | timestamptz | Yes |  |  | When employees could see their payslips. |
| `reviewed_by` | uuid | Yes | FK → user_accounts |  | Account that reviewed the run (Summary sheet "Reviewed by"). |
| `reviewed_by_name` | text | Yes |  |  | Name of who reviewed it, kept if the account goes. |
| `reviewed_at` | timestamptz | Yes |  |  | When it was reviewed. |

### `payroll_run_lines`

One employee's pay in a run: the payslip.

| Column | Type | Null | Key | Default | Description |
|---|---|---|---|---|---|
| `payroll_run_id` | uuid | No | PK, FK → payroll_runs |  | The run. |
| `employee_id` | varchar(20) | No | PK, FK → employees |  | The employee. |
| `basic_pay` | numeric(12,2) | No |  |  | Half the monthly pay, or days employed if mid-cutoff. |
| `absence_deductions` | numeric(12,2) | No |  | `0` | Absences, AWOL, unpaid leave, undertime. |
| `overtime_pay` | numeric(12,2) | No |  | `0` | Approved overtime. |
| `premium_pay` | numeric(12,2) | No |  | `0` | Holiday, rest-day and night premiums. |
| `gross_pay` | numeric(12,2) | No |  |  | Gross. |
| `sss_ee` | numeric(10,2) | No |  | `0` | SSS employee share. |
| `sss_er` | numeric(10,2) | No |  | `0` | SSS employer share. |
| `sss_ec` | numeric(10,2) | No |  | `0` | Employees' Compensation. |
| `philhealth_ee` | numeric(10,2) | No |  | `0` | PhilHealth employee share. |
| `philhealth_er` | numeric(10,2) | No |  | `0` | PhilHealth employer share. |
| `pagibig_ee` | numeric(10,2) | No |  | `0` | Pag-IBIG employee share. |
| `pagibig_er` | numeric(10,2) | No |  | `0` | Pag-IBIG employer share. |
| `taxable_income` | numeric(12,2) | No |  |  | Gross less contributions and non-taxable items. |
| `withholding_tax` | numeric(12,2) | No |  | `0` | BIR withholding tax. |
| `net_pay` | numeric(12,2) | No |  |  | Take-home pay. |
| `computation` | jsonb | No |  |  | Full line-by-line computation and the attendance it used. |

### `payroll_adjustments`

Additions or deductions to one employee's pay in a run.

| Column | Type | Null | Key | Default | Description |
|---|---|---|---|---|---|
| `id` | uuid | No | PK | `gen_random_uuid()` | Primary key. |
| `payroll_run_id` | uuid | No | FK → payroll_runs |  | The run. |
| `employee_id` | varchar(20) | No | FK → employees |  | The employee this belongs to. |
| `label` | text | No |  |  | Shown on the payslip, e.g. Reimbursement. |
| `amount` | numeric(12,2) | No |  |  | Positive adds, negative deducts. |
| `is_taxable` | boolean | No |  | `false` | Taxable items go into gross before tax. |
| `reason` | text | No |  |  | Why. |
| `reimbursement_claim_id` | uuid | Yes | FK → reimbursement_claims |  | Claim being paid, if any. |
| `loan_id` | uuid | Yes | FK → loans |  | Loan whose installment this is, if any. |
| `is_automatic` | boolean | No |  | `false` | Added by payroll itself (a loan installment or an approved reimbursement), not by hand. |

### `loans`

Loans and other recurring deductions (SSS and Pag-IBIG loans, cash advances, company loans). Each payroll run deducts the installment until the balance is zero; final pay deducts what's left.

| Column | Type | Null | Key | Default | Description |
|---|---|---|---|---|---|
| `id` | uuid | No | PK | `gen_random_uuid()` | Primary key. |
| `employee_id` | varchar(20) | No | FK → employees |  | Who repays it. |
| `kind` | text | No |  |  | Kind of loan or deduction. Allowed: `SSS salary loan`, `SSS calamity loan`, `Pag-IBIG multi-purpose loan`, `Pag-IBIG calamity loan`, `Cash advance`, `Company loan`, `Other deduction`. |
| `reference` | text | No |  |  | The SSS/Pag-IBIG loan number, or what an Other deduction is for; encrypted by the app (AES-256-GCM). |
| `principal` | numeric(12,2) | No |  |  | The total to deduct. |
| `installment` | numeric(12,2) | No |  |  | Taken from each cutoff's pay until the balance is zero. |
| `start_date` | date | No |  |  | First cutoff it's deducted from (any date inside it). |
| `status` | text | No |  | `'active'` | Running, stopped (no more deductions, e.g. paid outside payroll) or settled (closed in final pay). Allowed: `active`, `stopped`, `settled`. |
| `note` | text | Yes |  |  | Note, or why the deductions stopped; encrypted by the app (AES-256-GCM). |
| `created_by` | uuid | Yes | FK → user_accounts |  | Who added it. |
| `created_by_name` | text | No |  |  | Name of who added it, kept if the account goes. |
| `created_at` | timestamptz | No |  | `now()` | When added. |
| `closed_by` | uuid | Yes | FK → user_accounts |  | Who stopped or settled it. |
| `closed_by_name` | text | Yes |  |  | Name of who closed it. |
| `closed_at` | timestamptz | Yes |  |  | When it was stopped or settled. |

### `employee_pay_profiles`

Each employee's pay settings (Payroll > Pay details): work week, allowances and tax-free pay the payroll engine uses. No row = 5-day week and no allowances.

| Column | Type | Null | Key | Default | Description |
|---|---|---|---|---|---|
| `employee_id` | varchar(20) | No | PK, FK → employees |  | Whose pay settings. |
| `work_week` | text | No |  | `'5-day'` | 5-day: Monday to Friday, 8 hours. 6-day: Monday to Friday 7 hours, Saturday 5. Allowed: `5-day`, `6-day`. |
| `transport_allowance` | numeric(12,2) | No |  | `0` | Transport allowance for a full cut-off, PHP; prorated by days attended, not taxed. |
| `ot_meal_rate` | numeric(10,2) | No |  | `0` | Paid for each day with approved overtime, PHP. |
| `de_minimis` | numeric(12,2) | No |  | `0` | De minimis benefits inside the basic pay each cut-off, PHP; not taxed. |
| `other_non_taxable` | numeric(12,2) | No |  | `0` | Other non-taxable pay inside the basic pay each cut-off, PHP. |
| `updated_at` | timestamptz | No |  | `now()` | Last change. |
| `updated_by` | uuid | Yes | FK → user_accounts |  | Account that made the last change. |
| `updated_by_name` | text | Yes |  |  | Name of who made the last change, kept if the account goes. |
| `client_share` | numeric(5,2) | No |  | `0` | Percent of the salary charged to Sphinx or a client (FT_MSMA % Sphinx), 0-100; booked to 14002 Advances - Sphinx. |
| `client` | text | No |  | `''` | Who the share is charged to (FT_MSMA client column); empty when nothing is charged. |
| `skip_sss` | boolean | No |  | `false` | True: no SSS taken from this person (sheet C typed 0). |
| `skip_philhealth` | boolean | No |  | `false` | True: no PhilHealth taken from this person (sheet C typed 0). |
| `skip_pagibig` | boolean | No |  | `false` | True: no Pag-IBIG taken from this person (sheet C typed 0). |

### `final_pay_cases`

Final pay (back pay) for someone leaving. Opened when HR records a separation or by Accounting; releasing it freezes the figures, settles the loans and pays out approved reimbursements.

| Column | Type | Null | Key | Default | Description |
|---|---|---|---|---|---|
| `id` | uuid | No | PK | `gen_random_uuid()` | Primary key. |
| `employee_id` | varchar(20) | No | FK → employees, UQ |  | Who is leaving (one case each). |
| `last_day` | date | No |  |  | Their last day. |
| `reason` | text | No |  |  | Why they're leaving; encrypted by the app (AES-256-GCM). |
| `opened_by` | uuid | Yes | FK → user_accounts |  | Who opened the case. |
| `opened_by_name` | text | No |  |  | Name of who opened it, kept if the account goes. |
| `opened_at` | timestamptz | No |  | `now()` | When opened. |
| `released_by` | uuid | Yes | FK → user_accounts |  | Who released it. |
| `released_by_name` | text | Yes |  |  | Name of who released it. |
| `released_at` | timestamptz | Yes |  |  | When released; the figures are frozen as they were then. |
| `release_reference` | text | Yes |  |  | Check or transfer reference; encrypted by the app (AES-256-GCM). |
| `release_items` | jsonb | Yes |  |  | The computation as released (a list of {label, detail, amount}; it names loan numbers), encrypted by the app (AES-256-GCM) and stored as one JSON string. |
| `release_total` | numeric(12,2) | Yes |  |  | Final pay as released (negative: the employee owes the difference). |

### `reimbursement_claims`

Expense claims with a receipt photo. The employee's approver endorses them, then Accounting gives the final approval.

| Column | Type | Null | Key | Default | Description |
|---|---|---|---|---|---|
| `id` | uuid | No | PK | `gen_random_uuid()` | Primary key. |
| `employee_id` | varchar(20) | No | FK → employees |  | The employee this belongs to. |
| `category` | text | No |  |  | Expense category. Allowed: `Transportation`, `Meals & client meetings`, `Office supplies`, `Communication`, `Training & seminars`, `Medical`, `Other`. |
| `other_type` | text | Yes |  |  | What they typed when the category is Other. |
| `merchant` | text | No |  |  | Store or provider on the receipt. |
| `purchase_date` | date | No |  |  | Date on the receipt (within 60 days). |
| `amount` | numeric(10,2) | No |  |  | Amount claimed (max 50,000). |
| `description` | text | No |  |  | What it was for. |
| `receipt_file_id` | uuid | No | FK → files |  | Receipt photo. |
| `status` | text | No |  | `'pending'` | Waiting for the approver, endorsed (waiting for Accounting), approved or rejected. Allowed: `pending`, `endorsed`, `approved`, `rejected`. |
| `filed_at` | timestamptz | No |  | `now()` | When filed. |
| `decided_by` | uuid | Yes | FK → user_accounts |  | Account that approved or declined it. |
| `decided_by_name` | text | Yes |  |  | Name of who decided, kept if the account goes. |
| `decided_at` | timestamptz | Yes |  |  | When it was decided. |
| `decision_note` | text | Yes |  |  | Note from the approver to the employee. |
| `approver_decided_by` | uuid | Yes | FK → user_accounts |  | Approver (the employee's supervisor) who endorsed or rejected it. |
| `approver_decided_by_name` | text | Yes |  |  | Name of that approver, kept if the account goes. |
| `approver_decided_at` | timestamptz | Yes |  |  | When the approver decided. |
| `approver_note` | text | Yes |  |  | The approver's note. |
| `paid_at` | timestamptz | Yes |  |  | When it was paid out. |
| `paid_by` | uuid | Yes | FK → user_accounts |  | Account that recorded the payout. |
| `paid_by_name` | text | Yes |  |  | Name of who paid it, kept if the account goes. |
| `payout_method` | text | Yes |  |  | How it was paid: with a payroll run, by bank transfer, or in final pay. Allowed: `payroll`, `transfer`, `final pay`. |
| `payout_reference` | text | Yes |  |  | The payroll run, the transfer reference, or Final pay; encrypted by the app (AES-256-GCM). |
| `release_method` | text | Yes |  |  | How Accounting released it straight to the employee: cash, bank transfer, e-wallet or check (payout_method is then 'transfer'). Empty for claims paid with payroll or final pay, or released before this was recorded. Allowed: `cash`, `transfer`, `e-wallet`, `check`. |

## Access, workflows & audit

Who can sign in and what they can do, how requests get approved, and the audit trail for every sensitive action.

### `subscription_plans`

The plans a client can be on (Administration > Clients & Subscriptions): employee seats, admin accounts and grace. Set up by our team.

| Column | Type | Null | Key | Default | Description |
|---|---|---|---|---|---|
| `id` | text | No | PK |  | Plan id, e.g. plan-starter. |
| `name` | text | No | UQ |  | Plan name, e.g. Starter. |
| `employee_seat_limit` | integer | No |  |  | Employees the plan covers: records that aren't Separated. |
| `admin_account_limit` | integer | No |  |  | Active HR, Approver and Accounting logins the plan covers. |
| `grace_percent` | smallint | No |  | `0` | How far past either limit adds are still allowed, in percent, rounded down to whole seats. |
| `is_active` | boolean | No |  | `true` | Offered when choosing a plan. |
| `sort_order` | smallint | No |  | `0` | Order in the plan list. |
| `created_at` | timestamptz | No |  | `now()` | When the row was created. |

### `subscriptions`

The company's HRIS plan (SaaS): plan, seat limit and billing period. One row per period; the newest one not cancelled or expired is current.

| Column | Type | Null | Key | Default | Description |
|---|---|---|---|---|---|
| `id` | uuid | No | PK | `gen_random_uuid()` | Primary key. |
| `plan_name` | text | No |  |  | Plan the company is on, e.g. Starter, Business. |
| `status` | text | No |  | `'active'` | Trial, active, past due (payment late), cancelled or expired. Allowed: `trial`, `active`, `past_due`, `cancelled`, `expired`. |
| `seat_limit` | integer | Yes |  |  | Most sign-in accounts the plan covers (System Admin accounts don't count); empty = no limit. |
| `billing_cycle` | text | No |  | `'monthly'` | How often it's billed. Allowed: `monthly`, `yearly`. |
| `price_per_seat` | numeric(10,2) | Yes |  |  | Price per seat per billing cycle. |
| `currency` | text | No |  | `'PHP'` | Currency of the price. |
| `starts_on` | date | No |  | `current_date` | First day of this subscription. |
| `current_period_end` | date | Yes |  |  | When the current billing period ends (renewal date). |
| `trial_ends_on` | date | Yes |  |  | Last day of the trial, while on trial. |
| `cancelled_at` | timestamptz | Yes |  |  | When it was cancelled. |
| `notes` | text | Yes |  |  | Notes from our team, e.g. the contract or invoice reference. |
| `created_at` | timestamptz | No |  | `now()` | When the row was created. |
| `created_by` | uuid | Yes | FK → user_accounts |  | Account that set it up. |
| `updated_at` | timestamptz | No |  | `now()` | Last change. |
| `updated_by` | uuid | Yes | FK → user_accounts |  | Account that made the last change. |
| `plan_id` | text | Yes | FK → subscription_plans |  | The plan in force (its seat, admin-account and grace limits); empty = no plan set, so nothing is limited. |
| `seat_limit_override` | integer | Yes |  |  | Employee seat limit our team set for this client in place of the plan's; empty = the plan's. |
| `extension_seats` | integer | Yes |  |  | Temporary extra employee seats, until extension_until. |
| `extension_until` | date | Yes |  |  | Last day the temporary extra seats apply. |
| `last_seat_level` | smallint | No |  | `0` | Highest seat threshold (percent of the limit) already logged and told to System Admins; falls back when usage drops, so each crossing is told once. Allowed: `0`, `80`, `90`, `100`. |
| `last_seat_alert` | smallint | Yes |  |  | Highest seat threshold Super Admins and HR were already told about; empty = none yet. Allowed: `0`, `80`, `90`, `100`. |

### `subscription_events`

Log of seat alerts, refused adds, upgrade requests and plan changes (Administration > Clients & Subscriptions).

| Column | Type | Null | Key | Default | Description |
|---|---|---|---|---|---|
| `id` | uuid | No | PK | `gen_random_uuid()` | Primary key. |
| `kind` | text | No |  |  | What happened. Allowed: `threshold`, `blocked`, `upgrade-request`, `plan-changed`, `seat-override`, `extension`. |
| `message` | text | No |  |  | What happened, in words (an upgrade request includes its note). |
| `by_account` | uuid | Yes | FK → user_accounts |  | Account that did it; empty for automatic alerts and refusals. |
| `by_name` | text | Yes |  |  | Name of who did it, kept if the account goes. |
| `seats` | text | No |  |  | Employee seats used / limit at that moment, e.g. 17 / 20. |
| `admins` | text | No |  |  | Admin accounts used / limit at that moment, e.g. 6 / 8. |
| `occurred_at` | timestamptz | No |  | `now()` | When. |

### `roles`

The fixed roles: the website's six (access matrix in src/lib/permissions.ts) plus Admin, the owner company's own role with Super Admin's access. Who may create which is in server/src/hierarchy.ts.

| Column | Type | Null | Key | Default | Description |
|---|---|---|---|---|---|
| `id` | text | No | PK |  | Role id, e.g. super-admin, hr. |
| `role_key` | text | No | UQ |  | Which role: the access matrix's six, or admin (ours). Allowed: `system_admin`, `admin`, `super_admin`, `hr`, `approver`, `accounting`, `employee`. |
| `name` | text | No | UQ |  | Display name. |
| `description` | text | No |  |  | What the role is for. |
| `workspace` | text | No |  |  | Workspace it signs into. Allowed: `employee`, `manager`, `admin`. |
| `is_built_in` | boolean | No |  | `false` | Built-in roles can't be deleted. |
| `is_super_admin` | boolean | No |  | `false` | Manages roles, settings and other super admins. |

### `user_accounts`

Sign-in accounts. Linked to an employee when the user is one.

| Column | Type | Null | Key | Default | Description |
|---|---|---|---|---|---|
| `id` | uuid | No | PK | `gen_random_uuid()` | Primary key. |
| `username` | text | No | UQ |  | Sign-in name. |
| `builtin_key` | text | Yes | UQ |  | Marks the accounts created at setup. Allowed: `superadmin`, `admin`, `hr`, `employee`. |
| `display_name` | text | No |  |  | Name shown in the app. |
| `password_hash` | text | No |  |  | Argon2id or bcrypt hash; never the password. |
| `employee_id` | varchar(20) | Yes | FK → employees, UQ |  | Employee record, if any. |
| `role_id` | text | No | FK → roles |  | Role. |
| `status` | text | No |  | `'active'` | Status. Allowed: `active`, `disabled`. |
| `must_change_password` | boolean | No |  | `false` | Force a change at next sign-in. |
| `last_sign_in_at` | timestamptz | Yes |  |  | Last successful sign-in. |
| `failed_attempts` | smallint | No |  | `0` | Failed sign-ins since the last success. |
| `locked_until` | timestamptz | Yes |  |  | Locked until this time. |
| `created_at` | timestamptz | No |  | `now()` | When the row was created. |
| `mfa_secret` | text | Yes |  |  | Authenticator-app (TOTP) secret once two-factor sign-in is on, encrypted by the app (AES-256-GCM). |
| `mfa_pending_secret` | text | Yes |  |  | Secret being set up, until the first code confirms it; encrypted by the app. |
| `mfa_enabled_at` | timestamptz | Yes |  |  | When two-factor sign-in was turned on; empty = off. |
| `mfa_last_step` | bigint | Yes |  |  | Last 30-second code step used, so a code can't be used twice. |

### `user_sessions`

Signed-in sessions. The browser holds the token in an HttpOnly cookie; only its hash is stored.

| Column | Type | Null | Key | Default | Description |
|---|---|---|---|---|---|
| `token_hash` | text | No | PK |  | SHA-256 of the session token. |
| `account_id` | uuid | No | FK → user_accounts |  | Who is signed in. |
| `created_at` | timestamptz | No |  | `now()` | Sign-in time. |
| `last_seen_at` | timestamptz | No |  | `now()` | Last request; idle sessions expire. |
| `expires_at` | timestamptz | No |  |  | Hard expiry. |
| `user_agent` | text | Yes |  |  | Browser, for the sign-in log. |
| `mfa_pending` | boolean | No |  | `false` | Password was right but the two-factor code isn't entered yet: this session can only enter the code. |

### `mfa_backup_codes`

One-time backup codes for two-factor sign-in, for when the phone is lost. Only hashes are stored.

| Column | Type | Null | Key | Default | Description |
|---|---|---|---|---|---|
| `id` | uuid | No | PK | `gen_random_uuid()` | Primary key. |
| `account_id` | uuid | No | FK → user_accounts |  | Whose code. |
| `code_hash` | text | No |  |  | Argon2 hash of the code; never the code. |
| `used_at` | timestamptz | Yes |  |  | When it was used; each code works once. |
| `created_at` | timestamptz | No |  | `now()` | When the row was created. |

### `user_preferences`

Each person's own settings (Settings > Account, Notifications, Appearance), kept with their account so they follow them to any computer. The theme stays on each device.

| Column | Type | Null | Key | Default | Description |
|---|---|---|---|---|---|
| `account_id` | uuid | No | PK, FK → user_accounts |  | Whose settings. |
| `display_name` | text | Yes |  |  | Name they'd like shown; empty = their account name. |
| `language` | text | No |  | `'en'` | Language. Allowed: `en`. |
| `timezone` | text | Yes |  |  | Their timezone; empty = the company default. |
| `date_format` | text | No |  | `'MMM d, yyyy'` | How dates are shown. Allowed: `MMM d, yyyy`, `dd/MM/yyyy`, `MM/dd/yyyy`, `yyyy-MM-dd`. |
| `week_start` | smallint | No |  | `0` | First day of the week: 0 = Sunday, 1 = Monday, 6 = Saturday. Allowed: `0`, `1`, `6`. |
| `notifications_on` | boolean | No |  | `true` | Master switch for alerts. |
| `notification_matrix` | jsonb | No |  | `'{}'` | Per event, in-app and email on or off, e.g. {leaveSubmitted: {inApp: true, email: false}}; events not listed use the defaults. |
| `quiet_hours_on` | boolean | No |  | `false` | No alerts during quiet hours. |
| `quiet_from` | time | No |  | `'20:00'` | Quiet hours start. |
| `quiet_to` | time | No |  | `'07:00'` | Quiet hours end. |
| `digest` | text | No |  | `'off'` | Email summary. Allowed: `off`, `daily`, `weekly`. |
| `density` | text | No |  | `'comfortable'` | Spacing of lists and tables. Allowed: `comfortable`, `compact`. |
| `reduce_motion` | boolean | No |  | `false` | Turn off animations. |
| `landing_path` | text | No |  | `''` | Page opened after signing in; empty = the workspace Home. |
| `two_step_requested` | boolean | No |  | `false` | The two-step switch in Settings > Security; stored only. Two-factor sign-in itself is user_accounts.mfa_enabled_at. |
| `updated_at` | timestamptz | No |  | `now()` | Last change. |

### `approval_workflows`

How each kind of request gets approved.

| Column | Type | Null | Key | Default | Description |
|---|---|---|---|---|---|
| `request_kind` | text | No | PK |  | Kind of request. Allowed: `leave`, `overtime`, `undertime`, `correction`, `profile`. |
| `remind_after_days` | smallint | No |  | `2` | Remind the approver after this many days (0 = never). |
| `is_active` | boolean | No |  | `true` | Active. |

### `approval_workflow_steps`

Ordered approval steps in a workflow.

| Column | Type | Null | Key | Default | Description |
|---|---|---|---|---|---|
| `request_kind` | text | No | PK, FK → approval_workflows |  | The workflow. |
| `step_no` | smallint | No | PK |  | Order, starting at 1. |
| `approver_kind` | text | No |  |  | Who approves. Allowed: `supervisor`, `department-head`, `role`. |
| `role_id` | text | Yes | FK → roles |  | Role that approves, when approver_kind = role. |
| `over_days` | numeric(5,2) | Yes |  |  | Only for leave longer than this many days. |

### `audit_log`

Append-only trail: sign-ins, admin changes, 201 File views and edits, timekeeping changes, payroll approvals.

| Column | Type | Null | Key | Default | Description |
|---|---|---|---|---|---|
| `id` | bigint | No | PK | `generated always as identity` | Sequence. |
| `occurred_at` | timestamptz | No |  | `now()` | When. |
| `actor_account_id` | uuid | Yes | FK → user_accounts |  | Who did it. |
| `actor_name` | text | No |  |  | Name at the time, kept if the account is deleted. |
| `module` | text | No |  |  | Area. Allowed: `Sign-in`, `Administration`, `People`, `Documents`, `Timekeeping`, `Leave`, `Reimbursements`, `Payroll`. |
| `action` | text | No |  |  | e.g. Viewed, Edited, Verified, Approved. |
| `employee_id` | varchar(20) | Yes | FK → employees |  | Whose record it touched, if any. |
| `target` | text | No |  |  | What it touched, e.g. Valid Government ID. |
| `detail` | text | Yes |  |  | Human-readable detail. |
| `data` | jsonb | Yes |  |  | Before/after values for edits. |

### `support_tickets`

Problems and questions the client's Super Admins, HR and Accounting send to our support team (Administration > Support). Our System Admins answer them and set status and priority.

| Column | Type | Null | Key | Default | Description |
|---|---|---|---|---|---|
| `id` | uuid | No | PK | `gen_random_uuid()` | Primary key. |
| `ticket_no` | integer | No | UQ |  | Ticket number shown to people, from 1001 up. |
| `subject` | text | No |  |  | Short title. |
| `category` | text | No |  |  | What it's about. Allowed: `Bug or error`, `How do I…`, `Account or sign-in`, `Payroll`, `Data fix`, `Billing`, `Feature request`. |
| `priority` | text | No |  | `'normal'` | How urgent it is. Allowed: `low`, `normal`, `high`, `urgent`. |
| `status` | text | No |  | `'open'` | Open, in progress, waiting for the client, resolved or closed. Allowed: `open`, `in_progress`, `waiting`, `resolved`, `closed`. |
| `filed_by` | uuid | Yes | FK → user_accounts |  | Account that filed it. |
| `filed_by_name` | text | No |  |  | Name of who filed it, kept if the account goes. |
| `page` | text | Yes |  |  | The page they were on, to help reproduce it. |
| `assignee` | text | Yes |  |  | Who on our support team is on it. |
| `created_at` | timestamptz | No |  | `now()` | When the row was created. |
| `updated_at` | timestamptz | No |  | `now()` | Last reply or change. |

### `support_ticket_messages`

The conversation on a support ticket, oldest first.

| Column | Type | Null | Key | Default | Description |
|---|---|---|---|---|---|
| `id` | uuid | No | PK | `gen_random_uuid()` | Primary key. |
| `ticket_id` | uuid | No | FK → support_tickets |  | The ticket. |
| `side` | text | No |  |  | Who wrote it: the client's people, or our support team. Allowed: `client`, `support`. |
| `author_id` | uuid | Yes | FK → user_accounts |  | Account that wrote it. |
| `author_name` | text | No |  |  | Name shown on the message (Support team for our replies). |
| `body` | text | No |  |  | The message, encrypted by the app (AES-256-GCM). |
| `created_at` | timestamptz | No |  | `now()` | When the row was created. |

### `notifications`

Bell notifications: one row per person told about a request, a decision or a change (the bell in the top bar). Created by the server with the change that causes them.

| Column | Type | Null | Key | Default | Description |
|---|---|---|---|---|---|
| `id` | uuid | No | PK | `gen_random_uuid()` | Primary key. |
| `account_id` | uuid | No | FK → user_accounts |  | Who it's for (the sign-in that sees it in their bell). |
| `topic` | text | No |  |  | What it's about, e.g. leave, claim, certificate, subscription (src/lib/noticeLinks.ts). |
| `kind` | text | No |  |  | Which icon the bell shows. Allowed: `request`, `approved`, `rejected`, `update`, `seat`, `alert`. |
| `title` | text | No |  |  | Headline, encrypted by the app (AES-256-GCM): it can name people and amounts. |
| `body` | text | No |  |  | Detail, encrypted by the app (AES-256-GCM). |
| `link` | text | Yes |  |  | The page it opens for this person's role; empty = nowhere. |
| `by_account` | uuid | Yes | FK → user_accounts |  | Account whose action caused it; empty for automatic alerts. |
| `by_name` | text | Yes |  |  | Name of who caused it, kept if the account goes. |
| `created_at` | timestamptz | No |  | `now()` | When the row was created. |
| `read_at` | timestamptz | Yes |  |  | When the person read it; empty = unread. |

## Announcements & compliance

Company announcements, the statutory filing calendar and job openings.

### `announcements`

Company news shown on employee dashboards.

| Column | Type | Null | Key | Default | Description |
|---|---|---|---|---|---|
| `id` | uuid | No | PK | `gen_random_uuid()` | Primary key. |
| `title` | text | No |  |  | Headline. |
| `body` | text | Yes |  |  | Full text. |
| `branch_id` | uuid | Yes | FK → org_units |  | Branch it's for; null = everyone. |
| `posted_by` | uuid | No | FK → user_accounts |  | Who posted it. |
| `posted_at` | timestamptz | No |  | `now()` | When. |
| `expires_at` | timestamptz | Yes |  |  | Hide after this time. |

### `compliance_filings`

Statutory remittances and returns: SSS, PhilHealth, Pag-IBIG, BIR.

| Column | Type | Null | Key | Default | Description |
|---|---|---|---|---|---|
| `id` | uuid | No | PK | `gen_random_uuid()` | Primary key. |
| `agency` | text | No |  |  | Agency. Allowed: `SSS`, `PhilHealth`, `Pag-IBIG`, `BIR`. |
| `filing` | text | No |  |  | e.g. Withholding tax remittance (1601-C). |
| `period` | text | No |  |  | Period covered, e.g. 2026-09. |
| `due_date` | date | No |  |  | Deadline. |
| `filed_on` | date | Yes |  |  | When filed; status is computed from this and due_date. |
| `reference_no` | text | Yes |  |  | Receipt or confirmation number. |
| `filed_by` | uuid | Yes | FK → user_accounts |  | Who filed it. |
| `note` | text | Yes |  |  | Note. |

### `job_requisitions`

Open positions being recruited for.

| Column | Type | Null | Key | Default | Description |
|---|---|---|---|---|---|
| `id` | uuid | No | PK | `gen_random_uuid()` | Primary key. |
| `position_id` | uuid | No | FK → positions |  | Position being filled. |
| `openings` | smallint | No |  | `1` | How many to hire. |
| `stage` | text | No |  | `'Sourcing'` | Stage. Allowed: `Sourcing`, `Interviewing`, `Offer extended`, `Filled`, `Cancelled`. |
| `opened_on` | date | No |  | `current_date` | When opened. |
| `opened_by` | uuid | Yes | FK → user_accounts |  | Who opened it. |

### `company_policies`

Company rules and policies HR publishes (Maintenance > Rules) for employees to read and acknowledge. Changing a published policy's title, text or document makes a new version that everyone acknowledges again.

| Column | Type | Null | Key | Default | Description |
|---|---|---|---|---|---|
| `id` | uuid | No | PK | `gen_random_uuid()` | Primary key. |
| `title` | text | No |  |  | e.g. Code of conduct. Unique among policies that aren't archived. |
| `category` | text | No |  |  | Kind of policy. Allowed: `Employee handbook`, `Code of conduct`, `Attendance & time`, `Leave`, `Pay & benefits`, `Data privacy`, `Health & safety`, `Other`. |
| `version` | integer | No |  | `1` | Starts at 1; goes up when a published policy's title, text or document changes. |
| `effective_date` | date | No |  |  | When it takes effect. |
| `summary` | text | No |  | `''` | Short summary shown in the list. |
| `body` | text | No |  | `''` | The policy text. |
| `file_id` | uuid | Yes | FK → files |  | Attached document (e.g. the signed PDF); the file and its name are encrypted in files. |
| `require_ack` | boolean | No |  | `true` | Employees must confirm they've read it. |
| `status` | text | No |  | `'draft'` | Draft (only HR sees it), published, or archived. Allowed: `draft`, `published`, `archived`. |
| `updated_by` | uuid | Yes | FK → user_accounts |  | Who last changed it. |
| `updated_by_name` | text | No |  |  | Name of who last changed it, kept if the account goes. |
| `updated_at` | timestamptz | No |  | `now()` | Last change. |
| `created_at` | timestamptz | No |  | `now()` | When the row was created. |

### `policy_acknowledgements`

Who confirmed reading which version of a company policy, and when.

| Column | Type | Null | Key | Default | Description |
|---|---|---|---|---|---|
| `policy_id` | uuid | No | PK, FK → company_policies |  | The policy. |
| `version` | integer | No | PK |  | The version they read. |
| `employee_id` | varchar(20) | No | PK, FK → employees |  | Who confirmed it. |
| `acknowledged_at` | timestamptz | No |  | `now()` | When they confirmed it. |

### `outbox_messages`

Email and text messages the system queues for people (Administration > Outbox), respecting their notification settings. Nothing sends them yet.

| Column | Type | Null | Key | Default | Description |
|---|---|---|---|---|---|
| `id` | uuid | No | PK | `gen_random_uuid()` | Primary key. |
| `employee_id` | varchar(20) | No | FK → employees |  | Who it goes to. |
| `channel` | text | No |  |  | Email or text message. Allowed: `email`, `sms`. |
| `recipient_name` | text | No |  |  | Name of who it goes to, as shown in the outbox. |
| `address` | text | No |  |  | Email address or mobile number it goes to, encrypted by the app (AES-256-GCM). |
| `subject` | text | No |  |  | Subject line, encrypted by the app (AES-256-GCM). |
| `body` | text | No |  |  | Message text, encrypted by the app (AES-256-GCM). |
| `event` | text | No |  |  | What it's about, e.g. leaveSubmitted, payslip, policy, wfh. |
| `status` | text | No |  | `'waiting'` | Waiting to go out, sent, failed, or cleared from the outbox by an administrator. Allowed: `waiting`, `sent`, `failed`, `cancelled`. |
| `queued_by` | uuid | Yes | FK → user_accounts |  | Account whose action queued it. |
| `queued_by_name` | text | No |  |  | Name of who queued it, kept if the account goes. |
| `created_at` | timestamptz | No |  | `now()` | When the row was created. |
| `sent_at` | timestamptz | Yes |  |  | When it went out; empty until a sender is connected. |

# Looking at the HeyHR database with psql

## Connect

```powershell
# Opens the heyhr database as the postgres user (asks for its password)
& "C:\Program Files\PostgreSQL\17\bin\psql.exe" -U postgres -d heyhr
```

Run these once after connecting (or put them in `%APPDATA%\postgresql\psqlrc.conf`):

```sql
\pset pager off        -- stop Windows' "more" from garbling long output
\pset format wrapped   -- fold wide columns to fit the window
```

## See the tables

```sql
\dt                    -- list every table
\dt+                   -- list every table with its size and description (what it's for)
\dt leave*             -- only tables whose name starts with "leave"
\d employees           -- one table's columns, types, keys and rules
\d+ employees          -- the same, plus a description of every column
\dn                    -- list schemas (everything is in "public")
\di                    -- list indexes
\ds                    -- list sequences (e.g. employee_id_seq for MSMA-00001 numbering)
```

## Read the data

```sql
SELECT * FROM employees;                         -- every row, every column
SELECT employee_id, first_name, last_name, email FROM employees;   -- only some columns
SELECT * FROM employees WHERE employee_id = 'MSMA-00001';          -- one employee (text goes in single quotes)
SELECT * FROM leave_requests ORDER BY filed_at DESC LIMIT 10;      -- newest 10 leave requests
SELECT count(*) FROM employees;                  -- how many rows
SELECT status, count(*) FROM leave_requests GROUP BY status;       -- how many per status
```

```sql
\x on                  -- show each row as a vertical list (easier for wide tables like employees)
SELECT * FROM employees LIMIT 1;
\x off                 -- back to the normal table layout
```

## Useful lookups for this system

```sql
-- Sign-ins and who they belong to (passwords are stored only as hashes)
SELECT username, display_name, role_id, status, employee_id, last_sign_in_at FROM user_accounts;

-- What each role can open
SELECT role_id, module, access FROM role_module_access ORDER BY role_id, module;

-- An employee's 201 document checklist
SELECT document_type, status, file_name, expires_on FROM employee_documents WHERE employee_id = 'MSMA-00001';

-- The latest 20 entries in the audit trail
SELECT occurred_at, actor_name, module, action, target, detail FROM audit_log ORDER BY occurred_at DESC LIMIT 20;

-- Which database migrations have been applied
SELECT * FROM schema_migrations;
```

## Getting around

```sql
\?                     -- every psql command
\h SELECT              -- help for an SQL command
\l                     -- list databases
\c heyhr               -- switch to the heyhr database
\q                     -- quit
```

Every SQL statement ends with `;`. Backslash commands (`\dt`, `\d`) don't need one. If the prompt changes to `heyhr-#`, psql is waiting for the rest of a statement: type `;` and press Enter, or `\r` to clear it.

Reading is always safe. Avoid `UPDATE`, `DELETE`, `DROP` and `TRUNCATE` here: change data through the app, so the rules and the audit trail apply.

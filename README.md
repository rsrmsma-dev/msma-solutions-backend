# MSMA HRIS backend (HeyHR API)

The API server and PostgreSQL database for the MSMA HRIS website (HeyHR). It covers
sign-in and accounts (including employee self-registration), People / 201 File, Leave,
Timekeeping & attendance, Payroll and government contributions, Reimbursements and
employee self-service.

Built with Fastify + plain SQL (`pg`) on PostgreSQL 17, in TypeScript run with `tsx`.

## Layout

```
server/        the API (Fastify): sign-in, sessions, every module's endpoints
database/      schema.sql, migrations/, data dictionary, psql cheat sheet, schema generator
src/lib/       rule files shared with the website (BRD employee checks, leave, shifts,
               contribution tables, claims), kept at the same paths the website uses
package.json   the shared files' one dependency (zod)
```

## Run it

Needs Node 22+ and PostgreSQL 17.

```powershell
npm install                 # here, for the shared rules (zod)
cd server
npm install
powershell -ExecutionPolicy Bypass -File setup-db.ps1   # builds the heyhr database, its app login and server/.env
npm run dev                 # API on http://127.0.0.1:3001
```

The website's dev server proxies `/api` to port 3001.

`setup-db.ps1` deletes and rebuilds the `heyhr` database. On a database that already has
data, apply new files from `database/migrations/` instead, as the `postgres` owner:

```powershell
psql -U postgres -d heyhr -v ON_ERROR_STOP=1 -f database/migrations/00X_name.sql
```

Other scripts (in `server/`):

- `npm run seed`: loads the starting setup (company settings, org structure, positions,
  roles, built-in sign-ins, leave types, shifts, contribution tables). Safe to re-run.
- `npm run set-password -- <username> <password>`: sets an account's password.
- `npm run encrypt-ids`: encrypts anything saved before encryption came in (after migrations 009–012). Safe to re-run.
- `backup-db.ps1`: backs up the database with `pg_dump` (checks the file opens, keeps 14 days);
  `-Install` schedules it every night at 1:00 AM. How to restore is at the top of the script.

## Database

- `database/schema.sql`: the whole schema (46 tables, migrations 001–013 included); every table and column is described,
  so `\dt+` and `\d+` in psql show what each is for.
- `database/DATA_DICTIONARY.md`: the same descriptions as a document.
- `database/PSQL_CHEATSHEET.md`: commands for looking at the database.
- `database/tools/spec.py`: the source of both; edit it, then run
  `python database/tools/gen.py database`.
- The `employees` table follows the BRD New Employees Template (v1.1, 11.2.1).

## Roles

Six fixed roles: System Admin, Super Admin, HR, Approver, Accounting, Employee. What each may do
is the access matrix in `src/lib/permissions.ts`, the same file the website reads, so pages and the
API always agree. Approvers act on their team (the people whose supervisor they are).

## Security notes

- Passwords are stored as Argon2 hashes; sessions are HttpOnly cookies, only a hash is kept.
- Every request is checked against the access matrix on the server.
- **Encryption:** government numbers, ID and license numbers, uploaded files and their names,
  leave reasons and case reasons are encrypted by the server (`server/src/crypto.ts`, AES-256-GCM)
  with `HEYHR_DATA_KEY` in `server/.env`. `setup-db.ps1` creates the key. Keep a copy of it
  somewhere safe and apart from the backups: without it that data can't be read back. New
  sensitive fields (e.g. face or fingerprint templates, bank accounts) should use `seal`/`open`
  from that file.
- **Two-factor sign-in (MFA)** with an authenticator app; the server side is done, see `server/MFA.md`.
- Sign-in: per-account lock and a per-network limit (set `TRUST_PROXY=1` behind a reverse proxy).
  The app's database login can't change or delete audit entries.
- `server/.env` holds the database password and the encryption key and is never committed.
- The built-in sign-ins in `server/src/seed.ts` are for first setup; change their passwords
  before real use.
- Payroll is computed in the browser, then checked and locked by the server; the server does
  not yet recompute pay itself.

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

## Database

- `database/schema.sql`: the whole schema (46 tables); every table and column is described,
  so `\dt+` and `\d+` in psql show what each is for.
- `database/DATA_DICTIONARY.md`: the same descriptions as a document.
- `database/PSQL_CHEATSHEET.md`: commands for looking at the database.
- `database/tools/spec.py`: the source of both; edit it, then run
  `python database/tools/gen.py database`.
- The `employees` table follows the BRD New Employees Template (v1.1, 11.2.1).

## Security notes

- Passwords are stored as Argon2 hashes; sessions are HttpOnly cookies, only a hash is kept.
- Every module checks the signed-in role's access; employees see and change only their own records.
- `server/.env` holds the database password and is never committed.
- The built-in sign-ins in `server/src/seed.ts` are for first setup; change their passwords
  before real use.
- Payroll is computed in the browser, then checked and locked by the server; the server does
  not yet recompute pay itself.

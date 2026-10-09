import json, re, sys, os
sys.path.insert(0, os.path.dirname(__file__))
from spec import DOMAINS

OUT = sys.argv[1]  # repo database/ dir
SP = os.path.dirname(__file__)  # dict.json (data for the published page) lands here

def parse(col):
    name, typ, flags, desc = col[:4]
    allowed = col[4] if len(col) > 4 else None
    f = {"name": name, "type": typ, "desc": desc, "allowed": allowed,
         "pk": False, "nn": False, "uq": False, "fk": None, "default": None}
    m = re.search(r"D:(.*)$", flags)
    if m:
        f["default"] = m.group(1).strip()
        flags = flags[:m.start()]
    for tok in flags.split():
        if tok == "PK": f["pk"] = True
        elif tok == "NN": f["nn"] = True
        elif tok == "UQ": f["uq"] = True
        elif tok.startswith("FK:"):
            t = tok[3:]
            f["fk"] = (t.split(".")[0], t.split(".")[1] if "." in t else None)
    return f

tables = {}
for d in DOMAINS:
    for name, desc, cols in d["tables"]:
        tables[name] = {"name": name, "desc": desc, "domain": d["key"], "cols": [parse(c) for c in cols]}

def pk_col(t):
    pks = [c for c in tables[t]["cols"] if c["pk"]]
    return pks[0]["name"] if len(pks) == 1 else None

# resolve FK target columns
for t in tables.values():
    for c in t["cols"]:
        if c["fk"]:
            tgt, col = c["fk"]
            assert tgt in tables, (t["name"], tgt)
            c["fk"] = (tgt, col or pk_col(tgt))
            c["type"] = next(x["type"] for x in tables[tgt]["cols"] if x["name"] == c["fk"][1])

def sql_default(c):
    dv = c["default"]
    if dv is None: return ""
    if dv.startswith("generated"): return " " + dv
    return f" DEFAULT {dv}"

lit = lambda v: "'" + v.replace("'", "''") + "'"

lines = ["-- HeyHR (MSMA HRIS) database schema — PostgreSQL 15+",
         "-- Generated from the frontend's data model (src/lib/**/types.ts).",
         "-- Data dictionary: database/DATA_DICTIONARY.md",
         "",
         "BEGIN;",
         "",
         "CREATE EXTENSION IF NOT EXISTS pgcrypto; -- gen_random_uuid() on PG < 13",
         "CREATE SEQUENCE employee_id_seq; -- EMPLOYEE_ID auto-numbering",
         "-- Which files in database/migrations have been applied (this schema includes them all).",
         "CREATE TABLE schema_migrations (version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now());",
         ""]
fks, idx = [], []
for d in DOMAINS:
    lines += [f"-- {'=' * 70}", f"-- {d['name']}", f"-- {'=' * 70}", ""]
    for name, _, _ in d["tables"]:
        t = tables[name]
        body = []
        pks = [c["name"] for c in t["cols"] if c["pk"]]
        for c in t["cols"]:
            s = f"  {c['name']} {c['type']}"
            if c["pk"] and len(pks) == 1: s += " PRIMARY KEY"
            elif c["nn"] or c["pk"]: s += " NOT NULL"
            if c["uq"]: s += " UNIQUE"
            s += sql_default(c)
            if c["allowed"]:
                vals = ", ".join(v if c["type"] in ("smallint",) else lit(v) for v in c["allowed"])
                s += f" CHECK ({c['name']} IN ({vals}))"
            body.append(s)
            if c["fk"]:
                tgt, tcol = c["fk"]
                if (name in ("remote_work_day_branches", "approval_workflow_steps", "payroll_run_lines") and c["pk"] and tgt != "employees") or name in ("user_sessions", "mfa_backup_codes"):
                    ondel = "CASCADE"  # rows that only exist as part of their parent
                elif not (c["nn"] or c["pk"]):
                    ondel = "SET NULL"
                else:
                    ondel = "RESTRICT"  # HR records are kept, never deleted out from under their history
                fks.append(f"ALTER TABLE {name} ADD CONSTRAINT {name}_{c['name']}_fkey FOREIGN KEY ({c['name']}) REFERENCES {tgt} ({tcol}) ON DELETE {ondel}{' ON UPDATE CASCADE' if tgt == 'employees' else ''};")
                if not c["pk"] or pks[0] != c["name"]:
                    idx.append(f"CREATE INDEX ON {name} ({c['name']});")
        if len(pks) > 1:
            body.append(f"  PRIMARY KEY ({', '.join(pks)})")
        lines.append(f"-- {t['desc']}")
        lines.append(f"CREATE TABLE {name} (")
        lines.append(",\n".join(body))
        lines.append(");")
        lines.append("")

# Descriptions from the data dictionary, so psql's \dt+ and \d+ show what each table and column is for.
comments = ["-- What each table and column is for (shown by \\dt+ and \\d+ in psql)"]
for t in tables.values():
    comments.append(f"COMMENT ON TABLE {t['name']} IS {lit(t['desc'])};")
    for c in t["cols"]:
        comments.append(f"COMMENT ON COLUMN {t['name']}.{c['name']} IS {lit(c['desc'])};")
lines += comments + [""]
lines += ["-- Extra integrity rules",
"ALTER TABLE leave_requests ADD CHECK (date_to >= date_from);",
"ALTER TABLE leave_requests ADD CHECK (half_day IS NULL OR date_from = date_to);",
"ALTER TABLE remote_work_days ADD CHECK (date_to >= date_from);",
"ALTER TABLE payroll_runs ADD CHECK (period_to >= period_from);",
"ALTER TABLE punches ADD CHECK (face_match IS NULL OR face_match BETWEEN 0 AND 100);",
"ALTER TABLE reimbursement_claims ADD CHECK (amount > 0 AND amount <= 50000);",
"ALTER TABLE reimbursement_claims ADD CHECK (category <> 'Other' OR other_type IS NOT NULL);",
"ALTER TABLE approval_workflow_steps ADD CHECK (approver_kind <> 'role' OR role_id IS NOT NULL);",
"ALTER TABLE contribution_rate_versions ADD UNIQUE (agency, effective_from);",
"ALTER TABLE subscriptions ADD CHECK (seat_limit IS NULL OR seat_limit > 0);",
"ALTER TABLE subscriptions ADD CHECK (price_per_seat IS NULL OR price_per_seat >= 0);",
"",
"-- New Employees Template rules (BRD v1.1, 11.2.1)",
"ALTER TABLE employees ADD CONSTRAINT employees_names_letters CHECK (last_name ~ $re$^[[:alpha:] .'-]+$$re$ AND first_name ~ $re$^[[:alpha:] .'-]+$$re$ AND (middle_name IS NULL OR middle_name ~ $re$^[[:alpha:] .'-]+$$re$));",
"ALTER TABLE employees ADD CONSTRAINT employees_mobile_format CHECK (mobile_no ~ '^09[0-9]{9}$');",
"ALTER TABLE employees ADD CONSTRAINT employees_email_format CHECK (email ~* $re$^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$$re$);",
"ALTER TABLE employees ADD CONSTRAINT employees_basic_rate_positive CHECK (basic_rate > 0);",
"CREATE UNIQUE INDEX employees_email_ci ON employees (lower(email));",
"-- Rules that depend on today's date can't be CHECK constraints, so a trigger enforces them.",
"CREATE FUNCTION employees_date_rules() RETURNS trigger LANGUAGE plpgsql AS $fn$",
"BEGIN",
"  IF NEW.birth_date > current_date - interval '18 years' THEN",
"    RAISE EXCEPTION 'Employee must be at least 18 years old' USING ERRCODE = 'check_violation';",
"  END IF;",
"  IF NEW.date_hired > current_date + 30 THEN",
"    RAISE EXCEPTION 'Date hired can''t be more than 30 days in the future' USING ERRCODE = 'check_violation';",
"  END IF;",
"  RETURN NEW;",
"END $fn$;",
"CREATE TRIGGER employees_date_rules BEFORE INSERT OR UPDATE OF birth_date, date_hired ON employees FOR EACH ROW EXECUTE FUNCTION employees_date_rules();",
"ALTER TABLE payroll_adjustments ADD FOREIGN KEY (payroll_run_id, employee_id) REFERENCES payroll_run_lines (payroll_run_id, employee_id) ON DELETE CASCADE;",
"",
"-- Foreign keys (added after every table exists, since some point both ways)"] + fks + ["", "-- Indexes on foreign keys and common lookups"] + sorted(set(idx)) + [
"CREATE INDEX ON punches (employee_id, work_date);",
"CREATE INDEX ON leave_requests (employee_id, date_from, date_to);",
"CREATE INDEX ON audit_log (employee_id, occurred_at DESC);",
"CREATE INDEX ON employee_documents (expires_on) WHERE expires_on IS NOT NULL;",
"",
"INSERT INTO schema_migrations (version) VALUES " + ", ".join(f"('{os.path.splitext(f)[0]}')" for f in sorted(os.listdir(os.path.join(OUT, "migrations")))) + ";" if os.path.isdir(os.path.join(OUT, "migrations")) and os.listdir(os.path.join(OUT, "migrations")) else "",
"COMMIT;", ""]
open(os.path.join(OUT, "schema.sql"), "w", encoding="utf-8", newline="\n").write("\n".join(lines))

# ---- Data dictionary (Markdown) ----
def key_of(c):
    k = []
    if c["pk"]: k.append("PK")
    if c["fk"]: k.append(f"FK → {c['fk'][0]}")
    if c["uq"]: k.append("UQ")
    return ", ".join(k)

md = ["# HeyHR data dictionary", "",
      f"PostgreSQL schema for the HRIS: {len(tables)} tables in {len(DOMAINS)} areas. The DDL is in [`schema.sql`](schema.sql).", "",
      "Conventions: `uuid` primary keys; money is `numeric(12,2)` in PHP; times are `timestamptz`; allowed values are enforced with `CHECK`. "
      "Computed figures (leave balances, daily attendance results, compliance status) are not stored.", ""]
for d in DOMAINS:
    md += [f"## {d['name']}", "", d["blurb"], ""]
    for name, _, _ in d["tables"]:
        t = tables[name]
        md += [f"### `{name}`", "", t["desc"], "", "| Column | Type | Null | Key | Default | Description |", "|---|---|---|---|---|---|"]
        for c in t["cols"]:
            desc = c["desc"] + (f" Allowed: {', '.join('`'+v+'`' for v in c['allowed'])}." if c["allowed"] and c["name"] != "id" else "")
            null = "No" if (c["nn"] or c["pk"]) else "Yes"
            md.append(f"| `{c['name']}` | {c['type']} | {null} | {key_of(c)} | {('`'+c['default']+'`') if c['default'] else ''} | {desc.replace('|', '/')} |")
        md.append("")
open(os.path.join(OUT, "DATA_DICTIONARY.md"), "w", encoding="utf-8", newline="\n").write("\n".join(md))

# ---- Data for the page ----
data = {"domains": [], "tables": {}}
for d in DOMAINS:
    data["domains"].append({"key": d["key"], "name": d["name"], "blurb": d["blurb"], "tables": [n for n, _, _ in d["tables"]]})
for t in tables.values():
    data["tables"][t["name"]] = {"desc": t["desc"], "domain": t["domain"], "cols": [
        {"n": c["name"], "t": c["type"], "null": not (c["nn"] or c["pk"]), "pk": c["pk"], "uq": c["uq"],
         "fk": c["fk"][0] if c["fk"] else None, "def": c["default"], "d": c["desc"], "a": c["allowed"] if c["name"] != "id" else None} for c in t["cols"]]}

# ---- Mermaid ERDs, one per area ----
def mtype(t):
    return re.sub(r"[^a-z_]", "", t.replace("[]", "_array")) or "text"
erds = {}
for d in DOMAINS:
    names = [n for n, _, _ in d["tables"]]
    out = ["erDiagram"]
    rels, outside = [], set()
    for n in names:
        t = tables[n]
        for c in t["cols"]:
            if c["fk"]:
                tgt = c["fk"][0]
                if tgt not in names: outside.add(tgt)
                one = "|o" if not (c["nn"] or c["pk"]) else "||"
                card = "||" if c["uq"] else "o{"
                rels.append(f'  {tgt} {one}--{card} {n} : "{c["name"]}"')
    for n in names:
        out.append(f"  {n} {{")
        for c in tables[n]["cols"]:
            keys = ",".join(k for k, on in (("PK", c["pk"]), ("FK", bool(c["fk"])), ("UK", c["uq"])) if on)
            out.append(f"    {mtype(c['type'])} {c['name']}{(' ' + keys) if keys else ''}")
        out.append("  }")
    for n in sorted(outside):
        out.append(f"  {n} {{")
        out.append(f"    uuid {pk_col(n) or 'id'} PK")
        out.append("  }")
    out += rels
    erds[d["key"]] = "\n".join(out)
data["erds"] = erds
data["outside"] = {d["key"]: sorted({c["fk"][0] for n, _, _ in d["tables"] for c in tables[n]["cols"] if c["fk"] and c["fk"][0] not in [x for x, _, _ in d["tables"]]}) for d in DOMAINS}
json.dump(data, open(os.path.join(SP, "dict.json"), "w", encoding="utf-8"), ensure_ascii=False)
print(len(tables), "tables,", sum(len(t["cols"]) for t in tables.values()), "columns,", len(fks), "foreign keys")

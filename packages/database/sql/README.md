# Saved SQL commands

Studio's **Database → Saved SQL** writes reviewed source here. Files are ordinary
PostgreSQL SQL and remain editable without Studio. Saving/discovery and normal
startup never execute them. Prisma schema migrations remain in `prisma/migrations`.

Use `seed/`, `backfill/`, `operation/`, or `inspection/`, with a lowercase command
name. Each `.sql` file begins with one metadata comment, followed by one statement:

```sql
-- framework-sql: {"version":1,"name":"demo_seed","kind":"seed","intent":"repeatable","description":"Disposable example data","parameters":["label"]}
INSERT INTO demo_items(label) VALUES ($1)
ON CONFLICT (label) DO NOTHING RETURNING label;
```

The example presumes a separately created table. Schema DDL, transaction controls,
and multi-statement batches belong in the existing migration workflow. Commands
support SELECT, WITH, INSERT, UPDATE and DELETE; SELECT INTO is rejected because it
creates schema objects. Metadata category and filename must agree. This directory
is not a second schema or deployment authority.

Parameters are named in positional order; supply JSON scalar values in Studio.
The installed PostgreSQL driver binds `$1`, `$2`, etc. Values never become SQL string
interpolation. Do not place secrets in repository SQL literals or metadata.
Parameter values and result rows are excluded from Studio's durable operation
history, but explicit results are visible in the browser. PostgreSQL's own logging
policy still applies.

Execution is a separate five-minute, single-use approval tied to exact file bytes
and private target identity. It uses the resolved loopback Compose target, never an
inherited `DATABASE_URL`, and does not start containers. Inspection runs in a
PostgreSQL read-only transaction and returns at most 100 rows. Writes run in an
explicit transaction with a 15-second statement and 5-second lock timeout. The
extended query protocol supplies the final single-statement boundary.

`repeatable` permits reruns; author idempotence with ON CONFLICT or a similar SQL
condition. `once` inserts into the reserved `framework_studio.sql_runs` schema/table in the same
transaction as the command. Its key is command path and parameter-set digest;
editing a committed command does not reset it. Use a new name for a new backfill.
The ledger stays outside the application's public namespace so strict Prisma schema
verification continues to match. It is operational metadata, not a migration marker, and must remain
with data when restoring/reusing the database. Arbitrary SQL or external restore
can invalidate its assumptions.
Older experimental `public._framework_studio_sql_runs` scratch tables are not
automatically adopted; this campaign feature has no shipped ledger migration.

Success requires PostgreSQL's acknowledged COMMIT. A failed statement with
acknowledged rollback reports unchanged. Lost COMMIT acknowledgement, interruption
or failed durable-history update reports an uncertain outcome and never triggers
automatic retry. Inspect actual rows and the once ledger first. Only stable SQLSTATE
codes cross the private driver boundary; free-form driver errors do not.

Production selection is blocked for saved SQL. Production schema/data changes
continue through the versioned VPC IAM/TLS migration task and separate target-bound
inspection/write approval. This interface does not turn it into a general
production SQL runner.

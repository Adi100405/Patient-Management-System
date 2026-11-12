import "dotenv/config";
import { config } from "dotenv";
import { neon } from "@neondatabase/serverless";

config({ path: ".env.local" });
config({ path: ".env" });

/**
 * Additive migration for the elastic-scheduling schema.
 *
 * `drizzle-kit push` is the normal way to sync this repo's schema, but it is
 * the wrong tool for a database that carries objects the checked-in schema does
 * not describe yet (the preview database holds the forgot-password tables
 * before that branch lands). Push diffs the whole schema and drops what it
 * cannot explain, so it would delete those objects. This script only ever adds.
 *
 * Every statement is idempotent, so running it twice is safe. It also repairs
 * object ownership, which is the failure that took the preview down: a
 * migration run with the production owner's credentials created
 * `schedule_changes` and `schedule_change_moves` owned by `neondb_owner`, while
 * the deployed app connects as `medrella_preview`. The app could read nothing
 * from them, so the first audit insert raised
 * `permission denied for table schedule_changes` and the whole server action
 * returned 500.
 *
 * Usage:
 *
 *   npm run db:migrate                       # additive schema only
 *   APP_DB_ROLE=medrella_preview npm run db:migrate
 *                                            # ...and hand every public object
 *                                            # to the role the app connects as
 *
 * Run it against the database named in `DATABASE_URL`. Never point it at
 * another environment to "fix" a preview.
 */

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL is missing. Set it for the database you mean to migrate.");
  process.exit(1);
}

const sql = neon(url);

/** The DDL this feature adds, in the order the foreign keys need it. */
const STATEMENTS: readonly string[] = [
  // The `needs_rebooking` enum value is added by the PR that ships the doctor
  // and patient dashboards: those views map every appointment status
  // exhaustively, so the status and the label that names it belong together.

  // FIFO truth lives here, because seat numbers are physical seats and a
  // cancelled seat is reused by the next booking.
  `alter table appointments add column if not exists queue_since timestamptz not null default now()`,
  `alter table appointments add column if not exists clinic_moved boolean not null default false`,

  // The displacement planner ranks a slot by this order.
  `create index if not exists appointments_slot_queue_idx
     on appointments (doctor_id, appointment_date, appointment_time, queue_since, id)`,

  `create table if not exists schedule_changes (
     id serial primary key,
     doctor_id integer not null references doctors(id) on delete cascade,
     availability_id integer references availability(id) on delete set null,
     previous_start_time text not null,
     previous_end_time text not null,
     previous_capacity integer not null,
     next_start_time text not null,
     next_end_time text not null,
     next_capacity integer not null,
     created_at timestamptz not null default now()
   )`,
  `create index if not exists schedule_changes_doctor_created_idx
     on schedule_changes (doctor_id, created_at)`,
  `create index if not exists schedule_changes_availability_idx
     on schedule_changes (availability_id)`,

  `create table if not exists schedule_change_moves (
     id serial primary key,
     change_id integer not null references schedule_changes(id) on delete cascade,
     appointment_id integer references appointments(id) on delete set null,
     outcome text not null,
     reason text not null,
     from_date text not null,
     from_time text not null,
     from_seat_number integer not null,
     to_availability_id integer references availability(id) on delete set null,
     to_date text,
     to_time text,
     to_seat_number integer,
     created_at timestamptz not null default now()
   )`,
  `create index if not exists schedule_change_moves_change_idx
     on schedule_change_moves (change_id)`,
  `create index if not exists schedule_change_moves_appointment_idx
     on schedule_change_moves (appointment_id)`,
];

async function columnExists(table: string, column: string) {
  const rows = await sql`
    select 1
    from information_schema.columns
    where table_schema = 'public' and table_name = ${table} and column_name = ${column}
  `;
  return rows.length > 0;
}

/**
 * Give every public table and sequence to the role the app connects as.
 *
 * Identifiers are quoted by `format()` on the server rather than concatenated
 * here, so a table name can never break out of its statement.
 */
async function adoptObjects(role: string) {
  const [exists] = await sql`select 1 from pg_roles where rolname = ${role}::text`;
  if (!exists) {
    console.error(`Role "${role}" does not exist in this database. Nothing adopted.`);
    process.exit(1);
  }

  const tableFixes = await sql`
    select format('alter table public.%I owner to %I', c.relname, ${role}::text) as statement
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind = 'r'
      and pg_get_userbyid(c.relowner) <> ${role}::text
    order by c.relname
  `;
  for (const fix of tableFixes) await sql.query(fix.statement);

  const sequenceFixes = await sql`
    select format('alter sequence public.%I owner to %I', c.relname, ${role}::text) as statement
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind = 'S'
      and pg_get_userbyid(c.relowner) <> ${role}::text
    order by c.relname
  `;
  for (const fix of sequenceFixes) await sql.query(fix.statement);

  console.log(
    `Ownership adopted by ${role}: ${tableFixes.length} table(s), ${sequenceFixes.length} sequence(s).`,
  );

  // Ownership is the fix, but prove the app can actually read and write rather
  // than assume it. This is the exact check that would have caught the outage.
  const unreadable = await sql`
    select c.relname
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    cross join pg_roles r
    where r.rolname = ${role}::name
      and n.nspname = 'public' and c.relkind = 'r'
      and not (has_table_privilege(r.oid, c.oid, 'SELECT')
           and has_table_privilege(r.oid, c.oid, 'INSERT')
           and has_table_privilege(r.oid, c.oid, 'UPDATE'))
    order by c.relname
  `;
  if (unreadable.length > 0) {
    console.error(
      `Still inaccessible to ${role}: ${unreadable.map((row) => row.relname).join(", ")}`,
    );
    process.exit(1);
  }
  console.log(`Verified: ${role} can select, insert and update every public table.`);
}

async function main() {
  const [target] = await sql`select current_database() as database, current_user as role`;
  console.log(`Migrating ${target.database} as ${target.role}.`);

  // Backfill only on the run that first adds the column. Running it again later
  // would rewrite genuine queue times, because a fresh booking's default
  // `now()` can sit a hair after its `created_at`.
  const queueSinceWasMissing = !(await columnExists("appointments", "queue_since"));

  for (const statement of STATEMENTS) await sql.query(statement);

  if (queueSinceWasMissing) {
    const backfilled = await sql`
      update appointments set queue_since = created_at returning id
    `;
    console.log(`Queue times backfilled for ${backfilled.length} existing booking(s).`);
  }

  console.log("Additive schema is up to date.");

  const appRole = process.env.APP_DB_ROLE?.trim();
  if (appRole) {
    await adoptObjects(appRole);
  } else {
    console.log(
      "Skipped ownership. Set APP_DB_ROLE to the app's database role when the migration ran as a different one.",
    );
  }
}

main().catch((error) => {
  console.error("Migration failed:", error.message);
  process.exit(1);
});
import "dotenv/config";
import { config } from "dotenv";
import { neon } from "@neondatabase/serverless";

config({ path: ".env.local", quiet: true });
config({ path: ".env", quiet: true });

/**
 * Additive migration for the schema the deployed app expects.
 *
 * Production predates three batches that are now on `main`: wave/stream
 * scheduling, password reset and the displacement audit. The gap is not
 * cosmetic — `signInAction` reads every `users` column, so the missing
 * `password_changed_at` alone makes sign-in return 500 before the dashboard is
 * ever reached.
 *
 * `drizzle-kit push` is the normal way to sync this repo's schema, but it is
 * the wrong tool for a database that carries objects the checked-in schema does
 * not describe yet: push diffs the whole schema and drops what it cannot
 * explain. This script only adds. The single exception is the old
 * `appointments_booked_slot_unique` index, which enforces one booking per slot
 * and would reject the second seat of a wave slot; it is replaced by
 * `appointments_booked_seat_unique` in the same run.
 *
 * Every statement is idempotent, so running it twice is safe. All statements
 * run in one transaction, so a failure leaves the database untouched. The
 * script also repairs object ownership, which is the failure that took the
 * preview down: a migration run with the production owner's credentials created
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

/** The DDL this app needs, in the order the foreign keys need it. */
const STATEMENTS: readonly string[] = [
  // Password reset stores only a digest; `password_changed_at` is the trust
  // epoch a session is compared against on every guarded request.
  `alter table users add column if not exists password_changed_at timestamptz`,
  `create table if not exists password_reset_tokens (
     id serial primary key,
     user_id integer not null references users(id) on delete cascade,
     token_hash text not null unique,
     expires_at timestamptz not null,
     used_at timestamptz,
     created_at timestamptz not null default now()
   )`,
  `create index if not exists password_reset_tokens_user_created_idx
     on password_reset_tokens (user_id, created_at)`,

  // A block is either weekly (day_of_week) or date-based
  // (availability_dates), so day_of_week has to be nullable.
  `do $$ begin
     create type scheduling_type as enum ('wave', 'stream');
   exception when duplicate_object then null; end $$`,
  `alter type scheduling_type add value if not exists 'wave'`,
  `alter type scheduling_type add value if not exists 'stream'`,
  `alter table availability add column if not exists scheduling_type scheduling_type not null default 'wave'`,
  `alter table availability add column if not exists capacity integer not null default 1`,
  `alter table availability alter column day_of_week drop not null`,
  `do $$ begin
     alter table availability add constraint availability_capacity_positive check (capacity >= 1);
   exception when duplicate_object then null; end $$`,
  `create table if not exists availability_dates (
     availability_id integer not null references availability(id) on delete cascade,
     date text not null
   )`,
  `create unique index if not exists availability_dates_block_date_unique
     on availability_dates (availability_id, date)`,
  `create index if not exists availability_dates_date_idx on availability_dates (date)`,

  // Seat-based capacity replaces the one-booking-per-slot index below.
  `alter table appointments add column if not exists seat_number integer not null default 1`,
  `do $$ begin
     alter table appointments add constraint appointments_seat_positive check (seat_number >= 1);
   exception when duplicate_object then null; end $$`,
  `drop index if exists appointments_booked_slot_unique`,
  `create unique index if not exists appointments_booked_seat_unique
     on appointments (doctor_id, appointment_date, appointment_time, seat_number)
     where status = 'booked'`,

  // FIFO truth lives here, because seat numbers are physical seats and a
  // cancelled seat is reused by the next booking.
  `alter table appointments add column if not exists queue_since timestamptz not null default now()`,
  `alter table appointments add column if not exists clinic_moved boolean not null default false`,

  // The displacement planner ranks a slot by this order.
  `create index if not exists appointments_slot_queue_idx
     on appointments (doctor_id, appointment_date, appointment_time, queue_since, id)`,

  // `needs_rebooking` is an exception state, not history: the visit keeps its
  // payment and waits for a new time.
  `alter type appointment_status add value if not exists 'needs_rebooking'`,

  // One row per doctor edit and one row per displaced visit.
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

  const queries = STATEMENTS.map((statement) => sql.query(statement));
  if (queueSinceWasMissing) {
    queries.push(sql`update appointments set queue_since = created_at`);
  }

  await sql.transaction(queries);
  console.log(`Applied ${STATEMENTS.length} statements in one transaction.`);

  if (queueSinceWasMissing) {
    const [backfilled] = await sql`select count(*)::int as count from appointments`;
    console.log(`Queue times backfilled for ${backfilled.count} existing booking(s).`);
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

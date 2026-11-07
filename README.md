# Medrella — Patient Management System

A working appointment booking application built for the PearlThoughts Full Stack
internship. Patients find doctors, pick a free slot, and book; doctors see bookings
appear in their dashboard instantly.

## Features

- **Authentication** — email/password signup and signin with role selection (patient / doctor), JWT session in an httpOnly cookie, role-guarded dashboards via middleware
- **Doctor directory** - search by name or specialization, profile pages with fees, experience and availability
- **Wave and Stream scheduling** - a *wave* holds several patients in one visit slot (10:00-12:00, 30-minute visits, 3 patients per slot); a *stream* books a whole window as one start–end range (16:00-19:00, capacity 5 → the patient books `4:00 PM – 7:00 PM`, and seat numbers order the queue through the window). Blocks either repeat every week or open on an explicit list of dates - one date is a single visit day, several are a recurring series. See [`docs/scheduling.md`](docs/scheduling.md)
- **Doctor availability management** - doctors add, remove or edit their own schedule blocks from the dashboard; overlapping blocks are refused, and windows with upcoming bookings cannot be removed — but they *can* be elastically edited (shrink 10:00–12:00 to 10:00–11:00, expand to 09:00–12:00, change capacity) with every booked visit kept standing where it is: an edit that would strand one is refused, naming the visit, and a stream window's booked patients are told when its end moves
- **Live slot availability** - slots are generated from each doctor's blocks, booked slots and past times are removed automatically, and wave slots show how many places are left; all comparisons use clinic time (Asia/Kolkata) so "today" is correct regardless of server time zone
- **Booking flow** - slot selection → optional reason → confirmation; bookings are re-validated server-side and take a numbered seat, backed by a partial unique index on (doctor, date, time, seat), so a slot can never hold more patients than its capacity allows - and a cancelled booking returns its seat automatically
- **Patient dashboard** — upcoming appointments, booking history, one-click cancel, notification preferences (email/SMS with consent)
- **Doctor dashboard** — schedule of booked patients with contact details, daily counts, cancel support
- **Notifications** — email (Resend) and mobile — SMS via Vonage or Twilio, with an honest trial-account fallback — with a durable audit ledger, idempotent sends, exponential-backoff retries, 24h/1h appointment reminders, and per-patient consent-aware channel preferences. See [`docs/notifications.md`](docs/notifications.md)
- **Post-visit care loop** — completing a visit can carry aftercare instructions (shown only on the patient's dashboard) and a recommended follow-up interval; Medrella thanks the patient after the visit and, when advised, nudges them to rebook. See [`docs/notifications.md`](docs/notifications.md)
- **Seeded demo data** — 6 doctors across cardiology, dermatology, orthopedics, pediatrics, general medicine and neurology

## Tech stack

| Layer | Choice |
|---|---|
| Framework | Next.js 15 (App Router) + TypeScript |
| UI | Tailwind CSS v4 + shadcn-style components |
| Backend | Next.js Server Actions |
| Database | PostgreSQL (Neon) |
| ORM | Drizzle ORM |
| Validation | Zod |
| Auth | JWT (jose) + bcrypt |
| Notifications | Resend (email) + Twilio (SMS) |
| Testing | Vitest |
| Hosting | Vercel + Neon |

## Data model

The scheduling core is `users`, `patients`, `doctors`, `availability`,
`availability_dates` and `appointments`. Around it sit `payments`, `refunds`,
`visit_notes`, `reminders`, `care_follow_ups` and the notification ledger.
See [`docs/ER-Diagram.md`](docs/ER-Diagram.md) for the ER diagram and
[`docs/er-diagram.dbml`](docs/er-diagram.dbml) for the DBML version.

## Getting started

```bash
npm install
cp .env.example .env.local   # then fill in DATABASE_URL and SESSION_SECRET
npm run db:push              # create tables
npm run db:seed              # load demo doctors + patient
npm run dev
```

Open http://localhost:3000.

### Demo accounts

| Role | Email | Password |
|---|---|---|
| Patient | patient@demo.com | password123 |
| Doctor | doctor@demo.com | password123 |

## Scripts

| Command | Description |
|---|---|
| `npm run dev` | Start the dev server |
| `npm run build` | Production build |
| `npm run lint` | ESLint |
| `npm run typecheck` | TypeScript check |
| `npm test` | Run the unit tests (Vitest) |
| `npm run db:push` | Push the Drizzle schema to the database |
| `npm run db:seed` | Reset and seed demo data |
| `npm run db:studio` | Open Drizzle Studio |

## Deployment

1. Create a PostgreSQL database on [Neon](https://neon.tech) and copy the connection string
2. Import the repo on [Vercel](https://vercel.com)
3. Add environment variables: `DATABASE_URL`, `SESSION_SECRET`, plus
   `CRON_SECRET` and — for real notifications — `RESEND_API_KEY` / `RESEND_FROM`
   and the `TWILIO_*` trio (see [`docs/notifications.md`](docs/notifications.md))
4. Deploy, then run `npm run db:push` and `npm run db:seed` locally against the same database

## Day 1 (kept for reference)

The project started as a NestJS hello-world with an ER diagram for the Schedula
module; that history lives in PR #1. The app was then rebuilt on the recommended
Next.js stack for the appointment booking task.

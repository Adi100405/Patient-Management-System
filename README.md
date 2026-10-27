# Medrella — Patient Management System

A working appointment booking application built for the PearlThoughts Full Stack
internship. Patients find doctors, pick a free slot, and book; doctors see bookings
appear in their dashboard instantly.

## Features

- **Authentication** — email/password signup and signin with role selection (patient / doctor), JWT session in an httpOnly cookie, role-guarded dashboards via middleware
- **Doctor directory** — search by name or specialization, profile pages with fees, experience and weekly availability
- **Doctor availability management** — doctors add or remove their own weekly windows from the dashboard; new doctors are seeded with a default Mon–Fri 09:00–13:00 schedule so they are bookable immediately; windows with upcoming bookings cannot be removed
- **Live slot availability** — slots are generated from each doctor's availability windows (15/30/45/60-minute intervals), booked slots and past times are removed automatically; all comparisons use clinic time (Asia/Kolkata) so "today" is correct regardless of server time zone
- **Booking flow** — slot selection → optional reason → confirmation; bookings are re-validated server-side and backed by a partial unique index, so the same slot can never be double-booked
- **Patient dashboard** — upcoming appointments, booking history, one-click cancel
- **Doctor dashboard** — schedule of booked patients with contact details, daily counts, cancel support
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
| Hosting | Vercel + Neon |

## Data model

Five modules — `users`, `patients`, `doctors`, `availability`, `appointments`.
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
| `npm run db:push` | Push the Drizzle schema to the database |
| `npm run db:seed` | Reset and seed demo data |
| `npm run db:studio` | Open Drizzle Studio |

## Deployment

1. Create a PostgreSQL database on [Neon](https://neon.tech) and copy the connection string
2. Import the repo on [Vercel](https://vercel.com)
3. Add environment variables: `DATABASE_URL`, `SESSION_SECRET`
4. Deploy, then run `npm run db:push` and `npm run db:seed` locally against the same database

## Day 1 (kept for reference)

The project started as a NestJS hello-world with an ER diagram for the Schedula
module; that history lives in PR #1. The app was then rebuilt on the recommended
Next.js stack for the appointment booking task.

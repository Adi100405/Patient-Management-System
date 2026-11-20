# The desk queue — check-in and tokens

A booking says a patient has a place. A check-in says they have **arrived**.

The clinic desk needs three things from the app: the moment a patient
arrived, the number on the slip they were given, and who is in the room right
now. This is that, plus the queue those three things imply.

## Three facts on the appointment

| Column | Meaning |
|---|---|
| `checked_in_at` | When the patient arrived at the desk. `null` means they have not arrived. |
| `token_number` | The number on their slip, unique per doctor per clinic day. |
| `serving_started_at` | When the doctor called them in. |

Nothing else is stored. In particular there is **no queue position column**,
and that is the whole design.

## Why positions are worked out, not stored

The place in line is derived every time the queue is read, from the order
people checked in:

```ts
buildQueue(rows)  // lib/queue.ts — pure, no database
```

A position that is stored has to be renumbered whenever anything changes: a
cancellation, a no-show, a finished visit, a patient arriving late. Every one
of those is a chance to leave a stale number on a screen. A position that is
derived cannot go stale, because it is recomputed from the check-in times
every single time the board is drawn.

So:

- **Cancel** → the row leaves the queue; the people behind move up. Nothing to
  renumber, because nothing was stored.
- **No-show** → same. The visit is marked missed and the queue closes the gap.
- **Completed** → the patient leaves the queue; the next one becomes first.
- **Called in** → the patient stops waiting and becomes the patient in the room.

The queue order is the check-in order, with the appointment id as the
tie-break, so two people checked in in the same second still have a fixed
order.

## Tokens are the opposite, and that is deliberate

A token is a fact about an **arrival**, not a counter of who is still waiting.
It is handed out once, never renumbered and never reused:

```sql
CREATE UNIQUE INDEX appointments_doctor_day_token_unique
  ON appointments (doctor_id, appointment_date, token_number)
  WHERE token_number IS NOT NULL;
```

If the doctor cancels the visit that held token 4, the next patient gets
token 5, not token 4. A patient who is told "you are T-04" can walk in and
say it without the desk having to remember whether that number was recycled.

Tokens are per doctor per clinic day. Two doctors both running a clinic on the
same day each hand out their own numbers; the token identifies a place in one
doctor's queue, which is the queue the patient is actually standing in.

## Checking in

The desk checks a patient in, and only the doctor who owns the visit can do it.

- **When** — check-in opens **60 minutes before** the booked time and stays
  open for the rest of the visit day. Opening it earlier would let a patient
  who turns up at nine in the morning take a low token for a six o'clock visit.
- **Twice** — the write is guarded on the visit not being checked in yet:

  ```sql
  update appointments
     set checked_in_at = now(), token_number = $token
   where id = $id and doctor_id = $doctor and status = 'booked'
     and checked_in_at is null
  ```

  Two clicks, or two desks at once, cannot check the same patient in twice:
  the second attempt simply finds nothing to update. A token taken by another
  visit at the same moment is retried with the next number.
- **Wrong day** — a visit days away, or one already behind the clinic, is
  refused with a plain reason, not a silent no-op.

## One patient in the room

"Being seen" is not a guess about who is next in line; it is a fact the doctor
records by calling somebody in.

```sql
CREATE UNIQUE INDEX appointments_doctor_day_serving_unique
  ON appointments (doctor_id, appointment_date)
  WHERE serving_started_at IS NOT NULL AND status = 'booked';
```

Only `booked` visits hold the room, so finishing or cancelling the patient in
the room hands it to the next one without anybody releasing it by hand. Two
clicks on **Call next** can never put two people in front of the doctor at
once: the second one is refused.

## What else moves the queue

- **Reschedule** — refused once the patient has checked in. Their token and
  their place belong to the visit they walked in for, so the clinic has to be
  the one to move it.
- **A clinic edit that changes the day** — the check-in, token and place are
  cleared: the patient has not arrived for the new day yet. A retime inside
  the same day keeps them, because the patient is still standing at the desk.
- **A visit that loses its slot** (`needs_rebooking`) — the same: the check-in
  is cleared along with the seat.
- **Cancellation and no-show** — the visit leaves the queue by its status. The
  timestamps stay on the row as a record of what happened.

## What the patient sees

Their own visit only: the moment they checked in, their token, and their place
in line. Nobody else's name is on the patient's screen — the queue holds other
people's names, and that stays inside the doctor's dashboard.

- `Checked in at 10:42 AM · Token T-07 · Position 2`
- `Checked in at 10:42 AM · Token T-07 · You're next`
- `You are being seen now · T-07`
- `Not checked in yet · check-in opens at 9:30 AM`

## Where the code lives

| File | What it holds |
|---|---|
| `lib/queue.ts` | The pure domain: queue order, positions, tokens, the check-in window |
| `lib/queue-data.ts` | The reads: one doctor's day, one patient's own place in it |
| `actions/checkin.ts` | Check-in and Call next: authorisation, the atomic guards, token retry |
| `components/queue-board.tsx` | The doctor's desk board: in the room, waiting, not checked in |
| `components/queue-actions.tsx` | The two buttons that move the queue |
| `components/queue-status.tsx` | What the patient is told about their own visit |
| `app/dashboard/doctor/page.tsx` | Today's board above the days ahead |
| `app/dashboard/patient/page.tsx` | The patient's own queue line |
| `db/schema.ts` | The three columns and the two queue indexes |

## Applying the schema

`npm run db:migrate` adds the three columns and the three indexes. It only
adds, it is idempotent, and it needs no backfill: a booking made before this
feature simply reads as "not checked in".

See [`scheduling.md`](scheduling.md) for how the migration is run and why
ownership matters as much as the DDL.

## How to test it

1. Sign in as `doctor@demo.com` / `password123` and open the dashboard.
2. Book a visit for today (the doctor can add a window for today under
   **Availability**; a patient account can book it).
3. **Check in** the patient on the desk board. They get token `T-01` and the
   board shows them waiting.
4. Check in a second patient. They get `T-02` and sit at position 2.
5. Press **Check in** again on either of them. The button is gone, and the
   action refuses with *"Already checked in as token T-01."*
6. Press **Call next**. The first patient becomes the patient in the room; the
   second is now first in line.
7. Cancel the first patient from their dashboard (or mark them a no-show).
   They leave the queue and the second patient's position changes with it.
8. Sign in as the patient and look at the dashboard: the token, the position,
   and *"You are being seen now"* once the doctor calls them in.

# Scheduling — Wave and Stream

A doctor publishes **schedule blocks**. Each block says *when* the doctor works,
*how* that time turns into bookable appointments, and *how many* patients each
appointment can hold.

Two styles, two ways to repeat, one capacity rule.

## The two styles

| | **Wave** | **Stream** |
|---|---|---|
| Shape | A repeated visit slot | One continuous window, booked as a single item |
| Capacity means | Patients **per slot** | Patients **in the whole window** |
| Visit length | Set by the doctor (15/30/45/60 min) | Not set by the doctor |
| Patient sees | `10:00 · 2 left` | `10:00 AM – 12:00 PM` on its own row |

### Wave

The window is divided into fixed visit lengths. Every patient in one slot
starts at the same time, so the doctor sees them together.

> 10:00 – 12:00, 30-minute visits, capacity 3
>
> `10:00` (3 seats) · `10:30` (3 seats) · `11:00` (3 seats) · `11:30` (3 seats)

A visit that would run past the end of the window is not offered — a 10:00–11:20
window with 30-minute visits offers `10:00` and `10:30`, not `11:00`.

### Stream

The window is one bookable item: the patient books the whole run as a single
**start – end** range, and the capacity says how many patients may sit in it.
The doctor never sets a visit length.

> 10:00 – 12:00, capacity 5
>
> `10:00 AM – 12:00 PM` — one row, `5 of 5 places left`

There are no per-position times to choose from. A derived start time inside the
window (say 10:24) would be fiction: the clinic does not promise a patient a
particular moment inside the run, so no surface — the booking page, the
dashboard, a receipt, an email or an SMS — ever shows one.

Inside the window, every patient holds a **seat** (`seat_number`), but a seat is
a physical place, not a queue rank: a cancelled seat is reused by the next
booking, long after the queue first formed. Queue order is **FIFO by
`queue_since`**, with the appointment id as the tie-break — whoever joined the
slot first is seen first. The doctor's dashboard shows the range plus the real
place in line (`10:00 AM – 12:00 PM · queue #2 of 5`).

The window's spacing is still derived — `round(window minutes ÷ capacity)`,
never less than a minute — and stored on the block at publish time, so the
stored rules round-trip and a window can never promise more patients than it
has minutes. It is a publish-time fact, not something the patient ever sees.

## The two ways to repeat

| | **Every week** | **Specific dates** |
|---|---|---|
| Stored as | `availability.day_of_week` (0 = Sunday) | rows in `availability_dates` |
| One entry | A weekly block | A single visit day |
| Several entries | — | A recurring series |

A block is **either** weekly **or** date-based, never both: `day_of_week` is
nullable, and `null` means the block follows its explicit date list. One listed
date is a non-recurring block; several listed dates are a recurring series.

A block may list at most 30 dates (`MAX_BLOCK_DATES`).

## Capacity is enforced by the database

Every appointment carries a `seat_number` — which seat it holds, numbered from
one. The seats live in a partial unique index:

```sql
CREATE UNIQUE INDEX appointments_booked_seat_unique
  ON appointments (doctor_id, appointment_date, appointment_time, seat_number)
  WHERE status = 'booked';
```

That index is the authority. Two patients racing for seat one of a three-patient
wave cannot both win: one insert is refused by Postgres, and the loser re-reads
the taken seats and takes the next free one.

A stream's appointments all carry the **window's start** as their time, so the
same index and the same tally do the work: each seat is one of the window's
places, and the window is full when its capacity is booked. Queue order is kept
separately by `queue_since`; seat number never decides who is seen first.

- **No free seat** → the booking is refused with *"That slot is full."*
- **Lost the race** → the booking retries up to three times, then says *"That slot was just taken."*
- **Cancelled booking** → its row leaves the index (the index only holds `booked` rows), so the seat returns to the pool automatically. Nobody has to release it by hand.
- **Needs rebooking** → a displaced visit with no slot also leaves the index: it is waiting for a new time and must not hold its old seat.
- **Reschedule** → allocates a seat too, and the appointment's own row is excluded from the tally so it never competes with itself.

Capacity is therefore not a UI hint. The slot disappears from the DOM only
because the database refused the write that would have filled it.

## Overlapping blocks are refused

One doctor may not publish two blocks that cover the same clock time on the same
date — weekly vs weekly, weekly vs dated, dated vs dated. The two would compete
for the same seats and the seat numbers would stop meaning anything. The check
lives in `blocksConflict` (`lib/schedule.ts`) and runs before the insert.

A window that ends exactly when the next begins is fine — the overlap is
half-open.

## Elastic edits — every published window can change

A published block is not frozen. From **Dashboard → Availability**, a doctor
can **Edit** any block's start, end and capacity — shrinking a window
(10:00 – 12:00 → 10:00 – 11:00), expanding it (→ 09:00 – 12:00), moving its
start, or **closing** it (`end = start`, which offers no slots). Live bookings
never veto the change. A booked window still cannot be *removed* while it holds
upcoming visits; closing it keeps its history and moves the patients safely.

The form submits twice. **Preview impact** computes the exact consequence and
writes nothing. **Confirm and notify patients** recomputes it against fresh data
and applies it. Only a sibling overlap or a field rule can refuse an edit.

### Who moves, and where

Every visited slot is ranked **FIFO**: oldest `queue_since` first, appointment
id as the stable tie-break. Seat numbers play no part in the ranking.

- **Already started** — a visit whose slot has begun (clinic time) is locked in
  place. Moving a patient mid-visit is not a reschedule.
- **Wave** — positions are recomputed from the edited window. The oldest
  bookings keep their places while the position still exists; a capacity shrink
  keeps the oldest and displaces the newest. A position the edit removes — or a
  closed window — displaces every not-started booking in it.
- **Stream** — every live booking belongs to the window's start. Moving the
  start **retimes** each not-started booking to the new start, keeping its seat
  and its `queue_since`. Shrinking capacity keeps the oldest. Closing the window
  displaces every not-started booking.

A displaced visit is placed in the earliest free seat:

1. remaining capacity on the **same day**, earliest time first;
2. otherwise the **next seven days** (the original day + 0…7), earliest first;
3. if neither has room, it becomes **`needs_rebooking`**: the row releases its
   old seat, keeps its payment, and waits for the patient or clinic to pick a
   new time.

A clinic move **preserves** the patient's original `queue_since`. A reschedule
the patient chooses themselves resets it to now, because they joined the new
slot's queue at that moment.

### What the patient is told and can do

The clinic's assignment is binding, but the patient keeps three real choices:
keep the new time, reschedule it, or cancel it. Every moved or parked visit is
notified by email/SMS per the patient's channel choices:

- a **clinic move** names the previous slot, the new slot and why;
- a **needs-rebooking** notice says no slot was available and asks them to pick
  a time;
- a stream whose end alone moved (start and queue untouched) keeps the lighter
  *appointment window changed* notice.

Cancelling a **clinic-moved** visit is refunded in full, regardless of timing —
`appointment.clinic_moved` survives even a later patient reschedule so the
protection cannot be lost. A needs-rebooking row is cancellable and reschedulable
from the patient dashboard, and a successful reschedule turns it back into
`booked`.

Every edit also writes an audit trail: one `schedule_changes` row for the
before/after window, and one `schedule_change_moves` row per changed visit with
its from/to slot, reason and outcome. The audit records what actually happened,
not the preview: a patient who cancels mid-apply is left out, and a fallback
seat taken by a parallel booking turns that move into `needs_rebooking` instead
of failing the whole edit.

The planner lives in `lib/displacement.ts` — pure, like the rest of the domain —
and the action is `updateAvailability` (`actions/availability.ts`).

## Where the code lives

| File | What it holds |
|---|---|
| `lib/schedule.ts` | The pure domain: positions, seats, conflicts, offers, window labels, closed windows |
| `lib/displacement.ts` | The pure displacement planner: FIFO ranks, wave/stream edits, fallback placement, audit-ready outcomes |
| `lib/availability.ts` | Loads blocks (and their dates) from the database as domain blocks |
| `lib/seats.ts` | Seat tallies per slot and per date range; upcoming bookings per block and per doctor |
| `lib/slots.ts` | The clinic clock (IST), so "today" is right on a UTC server |
| `actions/availability.ts` | Publishing, removing and elastically editing blocks: preview, apply, audit, notifications |
| `actions/booking.ts` | Booking, rescheduling and cancellation, including clinic-moved refunds and needs-rebooking recovery |
| `db/schema.ts` | `scheduling_type`, `capacity`, `availability_dates`, `seat_number`, `queue_since`, `clinic_moved`, the seat index and the schedule audit tables |

`lib/schedule.ts` has no database access at all — it is pure functions over
plain data, which is why the rules can be tested without a database.

## How to test it

### As a doctor

1. Sign in as `doctor@demo.com` / `password123`.
2. Open **Dashboard → Availability**.
3. Choose **Scheduling style**: `Wave` or `Stream`.
4. Choose **Repeats**: `Every week` or `Specific dates`.
5. Set the window, the capacity, and (for a wave) the visit length.
6. **Add availability window.**

For a specific-dates block, type a date into the date field, press **Add
date**, and repeat. One date is a single visit day; several are a series.

The block then appears in the list, under *Specific dates* if it is date-based.

### As a patient

1. Sign in as `patient@demo.com` / `password123` (or create a patient account).
2. Open **Doctors → Aarav Mehta**.
3. Pick a day tab. The tab shows how many seats are free across the whole day.
4. Pick a slot.
   - A wave slot reads `10:00 · 2 left`.
   - A stream window reads `10:00 AM – 12:00 PM` on its own row, with the free
     places written under it.
5. **Confirm** the slot.

### Proving the capacity limit

The demo doctor has a Monday wave with capacity 3. To fill it:

1. Sign in as `patient@demo.com` in one window and book the Monday `10:00` slot.
2. Sign up two more patient accounts (two more browser windows, or a private
   window each) and book the same Monday `10:00` slot.
3. The fourth patient opens the page and finds the `10:00` slot **gone** — not
   greyed out, not clickable-and-refused, simply absent from the grid.

That absence is the database index doing its job.

### Proving a stream

The demo doctor has a Friday stream, 16:00–19:00, capacity 5. The profile page
shows **one** item for it — `4:00 PM – 7:00 PM`, spanning the whole window,
with `Stream window · 5 of 5 places left` written beside it. There is no list
of times inside the window to choose from, because there is no promised moment
inside the window to choose.

### Proving the dated blocks

The demo doctor also has a Tuesday series (three dates, capacity 2) and a single
Saturday stream (one date). Both show up as extra day tabs on the profile page,
and the Saturday block stops appearing once its date has passed.

### Proving an elastic edit

The seed books the demo patient into the doctor's Friday stream (seat 1), so
the displacement path has something to move.

1. Sign in as `doctor@demo.com`, open **Dashboard → Availability**, and press
   **Edit** on the Friday block. Change its end (16:00–19:00 → 16:00–18:00),
   press **Preview impact**, then confirm. The edit lands, the patient's
   dashboard and the doctor's schedule read the new range, and the patient
   receives an *appointment window changed* notice. Their queue place is
   unchanged.
2. Edit the same block's **start** and confirm. Every not-started booking is
   retimed to the new start and keeps its queue place; each patient receives a
   *clinic moved* notice. Their appointments now read the new start–end range.
3. Book a Monday wave slot, then shrink the Monday block's end past it. The
   preview names the patient and where they will move; confirming moves them
   into the next free slot — same day first, then the next seven days. If no
   slot exists, they become **needs rebooking** on both dashboards.
4. Set **From** and **To** to the same time to close a window. The preview
   says the window will close; confirming moves every not-started patient out.
   A visit that has already started stays exactly where it is.
5. Cancel a moved appointment from the patient dashboard: the dialog promises
   a **full refund** even inside two hours, and the cancellation goes through
   the clinic-cancellation refund path.
6. Open the availability editor with no bookings: it accepts any edit the field
   rules allow, exactly as before.

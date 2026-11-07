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

Inside the window, patients are seated in **queue order**: the first booking
takes seat 1, the next seat 2, and so on. The appointment stores the window's
start, and the seat number orders the clinic's queue through the window. The
doctor's dashboard shows the same range plus the patient's place in it
(`10:00 AM – 12:00 PM · #2 of 5`).

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
same index and the same tally do the work: seat 1 is the first patient in the
run, seat 2 the second, and the window is full when its capacity is booked.

- **No free seat** → the booking is refused with *"That slot is full."*
- **Lost the race** → the booking retries up to three times, then says *"That slot was just taken."*
- **Cancelled booking** → its row leaves the index (the index only holds `booked` rows), so the seat returns to the pool automatically. Nobody has to release it by hand.
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

## Elastic edits — shrinking and expanding a published window

A published block is not frozen. From **Dashboard → Availability**, a doctor
can **Edit** any block's start, end and capacity — shrinking a window
(10:00 – 12:00 → 10:00 – 11:00), expanding it (→ 09:00 – 12:00), or changing
how many patients it holds. A booked window cannot be *removed*, but it can
always be edited: that is exactly what keeps its bookings standing.

The rule underneath every edit: **a booked visit never moves.** Each visit's
date, start time and seat live on the appointment row itself, and an edit may
only change the block in ways that keep every upcoming booking valid where it
stands:

- **Wave** — every booked start time must still be a position of the edited
  window (a visit that no longer fits before the end would strand its
  patient), and the capacity may not drop below the busiest booked slot.
  Shrinking the end past a booked visit is refused, naming the visit;
  expanding is always safe.
- **Stream** — every booking anchors to the window's start, so a booked
  window's start cannot move at all. The end may shrink or expand freely —
  each patient's seat and queue place ride along — and the capacity may not
  drop below the busiest booked day.
- **A block with no upcoming bookings** accepts any edit, subject to the same
  field rules and the same overlap guard as a fresh block.

The scheduling style and the visit length are fixed at publish time —
regridding a wave's slots under booked visits would invent start times the
clinic never promised.

When a stream's end moves under booked visits, each of those patients receives
an *appointment window changed* notice (email/SMS per their channel choices)
carrying the previous and the new range; their start and queue place are
untouched. Wave visits anchor to their own start, which did not move, so wave
patients are told nothing.

The check lives in `elasticEditConflict` (`lib/schedule.ts`) — pure, like the
rest of the domain — and the action is `updateAvailability`
(`actions/availability.ts`).

## Where the code lives

| File | What it holds |
|---|---|
| `lib/schedule.ts` | The pure domain: positions, seats, conflicts, offers, window labels |
| `lib/availability.ts` | Loads blocks (and their dates) from the database as domain blocks |
| `lib/seats.ts` | Seat tallies per slot and per date range; upcoming bookings per block |
| `lib/slots.ts` | The clinic clock (IST), so "today" is right on a UTC server |
| `actions/availability.ts` | Publishing, removing and elastically editing blocks, with the overlap and booked-visit guards |
| `actions/booking.ts` | Booking and rescheduling, with seat allocation and retry |
| `db/schema.ts` | `scheduling_type`, `capacity`, `availability_dates`, `seat_number`, the seat index |

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
the guards have something to guard.

1. Sign in as `doctor@demo.com`, open **Dashboard → Availability**, and press
   **Edit** on the Friday block. Change its end (16:00–19:00 → 16:00–18:00)
   and save. The edit lands, the patient's dashboard and the doctor's schedule
   read the new range, and the patient receives a *visit window changed*
   notice. Their queue place is unchanged.
2. Try to move the same block's **start**. The edit is refused — bookings
   anchor to the start.
3. Book a Monday wave slot, then try to shrink the Monday block's end past it.
   The edit is refused, naming the booked time; shrink it to a point that keeps
   the booking, or expand it, and it saves.
4. Edit an unbooked block any way you like — with nothing booked, it accepts
   anything the field rules allow.

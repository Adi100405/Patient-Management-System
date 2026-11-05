# Scheduling — Wave and Stream

A doctor publishes **schedule blocks**. Each block says *when* the doctor works,
*how* that time turns into bookable appointments, and *how many* patients each
appointment can hold.

Two styles, two ways to repeat, one capacity rule.

## The two styles

| | **Wave** | **Stream** |
|---|---|---|
| Shape | A repeated visit slot | A continuous run of appointments |
| Capacity means | Patients **per slot** | Patients **in the whole window** |
| Visit length | Set by the doctor (15/30/45/60 min) | Derived from the capacity |
| Patient sees | `10:00 · 2 left` | `10:00` with a `Stream` badge |

### Wave

The window is divided into fixed visit lengths. Every patient in one slot
starts at the same time, so the doctor sees them together.

> 10:00 – 12:00, 30-minute visits, capacity 3
>
> `10:00` (3 seats) · `10:30` (3 seats) · `11:00` (3 seats) · `11:30` (3 seats)

A visit that would run past the end of the window is not offered — a 10:00–11:20
window with 30-minute visits offers `10:00` and `10:30`, not `11:00`.

### Stream

The window is divided into as many evenly spaced positions as the capacity
allows, and each position holds exactly one patient. The doctor never sets a
visit length; the capacity alone decides how many appointments fit and how far
apart they sit.

> 10:00 – 12:00, capacity 5
>
> `10:00` · `10:24` · `10:48` · `11:12` · `11:36`

The spacing is `round(window minutes ÷ capacity)`, never less than a minute, and
it is stored on the block at insert time — the client never computes it.

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

Every appointment carries a `seat_number` — which seat in the slot it holds,
numbered from one. The seats live in a partial unique index:

```sql
CREATE UNIQUE INDEX appointments_booked_seat_unique
  ON appointments (doctor_id, appointment_date, appointment_time, seat_number)
  WHERE status = 'booked';
```

That index is the authority. Two patients racing for seat one of a three-patient
wave cannot both win: one insert is refused by Postgres, and the loser re-reads
the taken seats and takes the next free one.

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

## Where the code lives

| File | What it holds |
|---|---|
| `lib/schedule.ts` | The pure domain: positions, seats, conflicts, offers, stream spacing |
| `lib/availability.ts` | Loads blocks (and their dates) from the database as domain blocks |
| `lib/seats.ts` | Seat tallies per slot and per date range |
| `lib/slots.ts` | The clinic clock (IST), so "today" is right on a UTC server |
| `actions/availability.ts` | Publishing and removing blocks, with the overlap guard |
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
   - A stream slot reads `10:00` with a `Stream` badge.
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
shows `16:00`, `16:36`, `17:12`, `17:48` and `18:24` — five evenly spaced
positions, each with one seat, and each badged `Stream`.

### Proving the dated blocks

The demo doctor also has a Tuesday series (three dates, capacity 2) and a single
Saturday stream (one date). Both show up as extra day tabs on the profile page,
and the Saturday block stops appearing once its date has passed.

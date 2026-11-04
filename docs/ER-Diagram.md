# Patient Management System — ER Diagram

Scheduling modules, in order: **User → Patient → Doctor → Availability →
AvailabilityDate → Appointment**.

The rest of the schema — payments, refunds, visit notes, reminders, care
follow-ups and the notification ledger — hangs off the appointment; it is
summarised at the bottom.

## Diagram

```mermaid
erDiagram
    USER {
        int id PK
        string email UK
        string password_hash
        enum role "DOCTOR | PATIENT"
        datetime created_at
    }

    PATIENT {
        int id PK
        int user_id FK UK
        string full_name
        string phone
        string date_of_birth
        string gender
    }

    DOCTOR {
        int id PK
        int user_id FK UK
        string full_name
        string specialization
        int experience_years
        string qualification
        decimal consultation_fee
        string bio
    }

    AVAILABILITY {
        int id PK
        int doctor_id FK
        enum scheduling_type "WAVE | STREAM"
        int day_of_week "0..6, null for a dated block"
        string start_time "09:00"
        string end_time "13:00"
        int slot_minutes "visit length, or derived stream spacing"
        int capacity "wave: per slot, stream: per window"
        boolean is_active
    }

    AVAILABILITY_DATE {
        int availability_id FK
        string date "2026-11-12"
    }

    APPOINTMENT {
        int id PK
        int patient_id FK
        int doctor_id FK
        int availability_id FK
        string appointment_date "2026-10-28"
        string appointment_time "10:30"
        int seat_number "which seat in the slot"
        enum status "BOOKED | COMPLETED | CANCELLED | NO_SHOW"
        string reason
        datetime created_at
    }

    USER ||--o| PATIENT : "extends (role = PATIENT)"
    USER ||--o| DOCTOR : "extends (role = DOCTOR)"
    DOCTOR ||--o{ AVAILABILITY : "publishes"
    AVAILABILITY ||--o{ AVAILABILITY_DATE : "opens on"
    DOCTOR ||--o{ APPOINTMENT : "receives"
    PATIENT ||--o{ APPOINTMENT : "books"
    AVAILABILITY ||--o{ APPOINTMENT : "slots into"
```

## Relationships Explained

| Relationship | Cardinality | Notes |
|---|---|---|
| User ↔ Patient | 1 : 0..1 | A user with role PATIENT has one patient profile |
| User ↔ Doctor | 1 : 0..1 | A user with role DOCTOR has one doctor profile |
| Doctor ↔ Availability | 1 : N | A doctor publishes many schedule blocks |
| Availability ↔ AvailabilityDate | 1 : N | The explicit dates a date-based block opens on |
| Patient ↔ Appointment | 1 : N | A patient can book many appointments |
| Doctor ↔ Appointment | 1 : N | A doctor can have many appointments |
| Availability ↔ Appointment | 1 : N | An appointment is booked into one block, and takes one seat of one slot |

## Design Notes

- **User** is the shared auth entity (email + password + role). Patient and
  Doctor each extend it 1-to-1, keeping auth concerns separate from domain
  profiles.
- **Availability** is one published schedule block. It is either **weekly**
  (`day_of_week` set, one weekday) or **date-based** (`day_of_week` null, rows
  in `availability_dates`) — never both.
- **`scheduling_type`** picks how the window becomes bookable positions.
  `WAVE` divides the window into fixed visits of `slot_minutes`, each holding
  `capacity` patients. `STREAM` divides the window into `capacity` evenly
  spaced positions of one patient each, and `slot_minutes` stores the derived
  spacing.
- **`availability_dates`** carries the explicit dates. One row is a single
  visit day; several rows are a recurring series.
- **Appointment.seat_number** is which seat in the slot the patient holds,
  numbered from one. Capacity is enforced by a partial unique index on
  `(doctor_id, appointment_date, appointment_time, seat_number)` where
  `status = 'booked'` — a cancelled row leaves the index, so its seat returns
  to the pool automatically.
- **Status** covers the booking → cancel → complete/no-show lifecycle.

## Other modules

| Table | Purpose |
|---|---|
| `payments` | One payment row per booking, from the moment the appointment exists |
| `refunds` | The refund trail for a cancelled or failed payment |
| `visit_notes` | Clinical notes and aftercare written after a visit |
| `reminders` | Scheduled appointment reminders |
| `care_follow_ups` | Recommended follow-ups, and whether the patient has rebooked |
| `notifications` | The durable notification ledger |
| `notification_preferences` | Per-patient channel consent |
| `notification_settings` | Workspace-level channel configuration |

See [`docs/notifications.md`](notifications.md) for the notification loop and
[`docs/scheduling.md`](scheduling.md) for how wave and stream blocks work.

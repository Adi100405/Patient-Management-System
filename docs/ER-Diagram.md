# Patient Management System — ER Diagram

Modules covered (in order): **User → Patient → Doctor → Availability → Appointment**

## Diagram

```mermaid
erDiagram
    USER {
        int id PK
        string email UK
        string phone UK
        string password_hash
        enum role "DOCTOR | PATIENT"
        string google_oauth_id
        boolean is_verified
        datetime created_at
    }

    PATIENT {
        int id PK
        int user_id FK
        string full_name
        date date_of_birth
        enum gender
        string address
        string emergency_contact
    }

    DOCTOR {
        int id PK
        int user_id FK
        string full_name
        string specialization
        int experience_years
        string qualification
        decimal consultation_fee
        enum verification_status "PENDING | APPROVED | REJECTED"
        string verification_token
        string bio
    }

    AVAILABILITY {
        int id PK
        int doctor_id FK
        enum day_of_week "MON..SUN"
        time start_time
        time end_time
        int slot_duration_minutes
        int max_appointments "elastic capacity"
        boolean is_active
    }

    APPOINTMENT {
        int id PK
        int patient_id FK
        int doctor_id FK
        int availability_id FK
        datetime appointment_time
        enum status "BOOKED | CONFIRMED | CANCELLED | RESCHEDULED | COMPLETED"
        string reason
        datetime booked_at
    }

    USER ||--o| PATIENT : "extends (role = PATIENT)"
    USER ||--o| DOCTOR : "extends (role = DOCTOR)"
    DOCTOR ||--o{ AVAILABILITY : "sets"
    DOCTOR ||--o{ APPOINTMENT : "receives"
    PATIENT ||--o{ APPOINTMENT : "books"
    AVAILABILITY ||--o{ APPOINTMENT : "slots into"
```

## Relationships Explained

| Relationship | Cardinality | Notes |
|---|---|---|
| User ↔ Patient | 1 : 0..1 | A user with role PATIENT has one patient profile |
| User ↔ Doctor | 1 : 0..1 | A user with role DOCTOR has one doctor profile |
| Doctor ↔ Availability | 1 : N | A doctor defines many availability windows (per weekday) |
| Patient ↔ Appointment | 1 : N | A patient can book many appointments |
| Doctor ↔ Appointment | 1 : N | A doctor can have many appointments |
| Availability ↔ Appointment | 1 : N | Appointments are booked against a slot window; `max_appointments` enables elastic scheduling |

## Design Notes

- **User** is the shared auth entity (email/phone/Google OAuth + role) — matches Week 1 auth endpoints (`/auth/signup`, `/auth/signin`, `/auth/signout`).
- **Patient** and **Doctor** extend User 1-to-1, keeping auth concerns separate from domain profiles.
- **Availability** is per doctor per weekday with `slot_duration_minutes` and `max_appointments` to support elastic scheduling (Week 3) — doctors can expand consulting hours and capacity.
- **Appointment** links patient, doctor, and the availability slot it was booked into; `status` covers the booking → confirm → cancel/reschedule lifecycle (Weeks 2–3).

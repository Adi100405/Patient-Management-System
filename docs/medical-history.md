# Medical history

A patient's medical record is the clinical context a doctor needs before seeing
them: blood group, allergies, existing conditions, current medications and free
notes. This document covers how it is stored, who may read or change it, and
where the data is allowed to appear.

## The model: an append-only log

`medical_history_entries` holds **full snapshots**, one row per save.

| Column | Meaning |
|---|---|
| `patient_id` | whose record |
| `blood_group` | one of the eight standard groups, or null |
| `allergies` | free text |
| `conditions` | free text — existing conditions |
| `medications` | free text — current medications |
| `notes` | other medical details |
| `recorded_by_user_id` | the account that saved the revision (nullable) |
| `recorded_by_name` | author name, snapshotted |
| `recorded_by_role` | author role, snapshotted |
| `created_at` | when the revision was saved |

The newest row is the **current record**; every older row is the **update
history**. The app inserts and reads this table; it never updates or deletes a
row.

That shape is deliberate. The Neon HTTP driver does not support transactions, so
a "current record" table paired with a separate audit table could drift: the
current row could update while its audit row failed. With one insert per
version, the audit trail *is* the record — it cannot disagree with itself.

A save that changes nothing writes nothing, so the history lists real changes
rather than button presses.

Null means **not recorded**, and is kept distinct from an empty string. The UI
renders it as "Not recorded", never as "No known allergies" or "None". An
unrecorded field must not read as a clinical negative.

## Visit details

The medical record is the standing context; `visit_notes` is what happened at a
specific consultation. One row per completed appointment carries four optional
fields:

| Field | Meaning |
|---|---|
| `diagnosis` | the short clinical conclusion |
| `summary` | what was found and done during the consultation |
| `aftercare` | the instructions the patient takes home |
| `follow_up_days` | the recommended interval before the next visit |

The doctor fills them in from the Complete action on the queue or the
appointment row. They are written only after the appointment has moved to
`completed`, so a no-show leaves no clinical note behind.

All four are patient-visible: the doctor's patient record shows them in the
visit history, and the patient's own dashboard shows them under **Completed
visits**. They are never copied into an email, SMS, notification, receipt or the
assistant.

A null field means the doctor did not record it. The UI omits it rather than
showing an empty heading.

## Access

| Role | Read | Write |
|---|---|---|
| Doctor | A patient with at least one appointment together, past or present | Yes, through a new revision |
| Patient | Their own record on their dashboard | No |
| Receptionist | No | No |

The relationship check is `doctorCanAccessPatient` in
`lib/medical-history-data.ts`: a single appointment row connecting the doctor
and the patient is what grants access. This covers cancelled and no-show visits
too — a doctor who has seen the patient once keeps the clinical context.

The guard runs twice. The page calls it before rendering, and
`saveMedicalHistory` calls it again before writing. A page guard alone does not
protect a server action from a crafted request.

A doctor without the relationship sees the same not-found page as a doctor
asking for a patient id that does not exist. The page never confirms that a
record exists to somebody who may not read it.

## Where the data appears

Medical history is PHI, scoped to:

- the patient's own dashboard (read-only), and
- the treating doctor's patient record page.

It is **never** copied into email, SMS, notifications, receipts or the assistant.
Those channels link to the dashboard; they do not quote clinical content.

Visit notes — aftercare, follow-up, diagnosis and summary — follow the same
rule. They appear on the patient's dashboard and the doctor's patient record,
never in a message.

## Reading the trail

`medicalHistoryRevisions(patientId)` returns newest first, so `revisions[0]` is
current. The card above the editor shows that snapshot and, under "Update
history", each older revision as the change it introduced: field, before value,
after value, author and clinic-time timestamp.

Visit history on the doctor's page includes appointments with every doctor in
the clinic, not only the viewer. A partial history would hide the context the
record exists to provide; the care-relationship check is what controls access to
the page.

## Migration

`db/migrate.ts` creates the table and its patient/timestamp index additively and
idempotently. It runs in one transaction with the rest of the schema and adopts
object ownership when `APP_DB_ROLE` is set:

```bash
npm run db:migrate
APP_DB_ROLE=medrella_preview npm run db:migrate
```

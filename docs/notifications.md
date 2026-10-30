# Notifications

How Medrella tells patients what happened to their appointments: which channels
exist, which events fire, how delivery is tracked and retried, and how to
operate the system.

## Architecture at a glance

```
appointment event (booking, cancel, reschedule, payment, refund, reminder)
        │
        ▼
lib/notifications/events.ts        one function per event; renders once
        │                          into email + (optional) SMS
        ▼
lib/notifications/preferences.ts   per-patient channel gate (consent-aware)
        │
        ▼
lib/notifications/dispatch.ts      claims the idempotency key, calls the
        │                          channel, records the outcome
        ▼
db.notifications (ledger)          queued → sent | failed (+ backoff)
        │                                 │
        ▼                                 ▼
Resend (email) / Twilio (SMS)      /api/cron/daily-sweep retries failures
```

Key files:

| File | Responsibility |
|---|---|
| `lib/notifications/templates.ts` | Pure message text. One reviewable place for every patient-facing sentence. |
| `lib/notifications/context.ts` | One query that resolves everything a template needs. |
| `lib/notifications/events.ts` | Event entry points (`sendBookingConfirmation`, …). Safe to call from any transactional flow — they never throw. |
| `lib/notifications/preferences.ts` | Loads a patient's channel choices; pure gate `channelsFor()`. |
| `lib/notifications/dispatch.ts` | Send-once-then-record core, injected with store + transport (unit-tested without a DB). |
| `lib/notifications/store.ts` | Drizzle implementation of the ledger. |
| `lib/notifications/retry-policy.ts` | `MAX_ATTEMPTS` and the backoff table. |
| `lib/notifications/reminders.ts` | Reminder sweep (24h / 1h before the visit). |
| `lib/notifications/channels/` | Transports: `resend.ts`, `twilio.ts`, `log.ts`. |

## Channels

### Email — Resend

| Env var | Required | Notes |
|---|---|---|
| `RESEND_API_KEY` | for real email | Without it, email degrades to the **log channel** (every message printed to the server log) so local dev and demos stay fully exercisable. |
| `RESEND_FROM` | no | Defaults to `Medrella <onboarding@resend.dev>`, which only delivers to your own Resend account address. |

Setup:

1. Create a Resend account and API key ([resend.com](https://resend.com)).
2. Verify your sending domain (Resend dashboard → Domains) and set
   `RESEND_FROM="Medrella <appointments@yourdomain.com>"`. Until the domain is
   verified, mail to anyone but the account owner is rejected by Resend.
3. Add the env vars in Vercel (Project → Settings → Environment Variables) and
   redeploy.

### SMS — Twilio

| Env var | Required | Notes |
|---|---|---|
| `TWILIO_ACCOUNT_SID` | for real SMS | From the Twilio console. |
| `TWILIO_AUTH_TOKEN` | for real SMS | Paired auth token. |
| `TWILIO_FROM` | for real SMS | An SMS-capable number or messaging service, E.164 (e.g. `+14155550123`). |

Setup:

1. Create a Twilio account; buy an SMS-capable number (or configure a
   Messaging Service).
2. Set the three env vars. **If any is missing, SMS is silently skipped** —
   attempts are still recorded on the ledger as not delivered. SMS never
   "falls back" to the log channel, because a printed SMS could be mistaken
   for a delivery.
3. Patient numbers are stored E.164-ish (optional `+`, 10–15 digits) and
   validated by the preferences action; Twilio requires E.164 on both sides.

Both transports use plain `fetch` with an 8-second timeout, so a hung provider
can never hold up a booking, payment or refund.

## Events

| Event | When it fires | Idempotency key |
|---|---|---|
| Booking confirmed | A slot is booked (manual or online) | `booking_confirmed:<id>` |
| Payment confirmed | A capture is first recorded (checkout or webhook) | `payment_confirmed:<id>` |
| Appointment cancelled | Patient, doctor or expired checkout | `appointment_cancelled:<id>` |
| Appointment rescheduled | Slot move succeeds | `appointment_rescheduled:<id>:<old>→<new>` |
| Refund initiated / completed / failed | Refund state transitions | `refund_<stage>:<id>` |
| Reminder (24h / 1h) | Reminder sweep finds a due window | none — the `reminders` table owns reminder dedup |

Every event renders one email and, when the template has one and the patient
opted in, one SMS. Each channel gets its own ledger row keyed
`<key>:email` / `<key>:sms`.

### Reminders

Reminders are never scheduled as per-appointment jobs. A sweep
(`sweepReminders`) reads live appointment state — booked visits only — so a
cancelled or completed visit stops its own reminders with no cleanup, and a
rescheduled visit is reminded at its new time. The `reminders` table's unique
`(appointment_id, kind)` index makes overlapping sweeps safe; a failed send
releases its claim so the next sweep retries. Windows are defined in
`REMINDER_WINDOWS` (24h: 2–25 hours before; 1h: 3–75 minutes before).

Triggers: the daily cron (below), and opportunistically whenever a patient
opens their dashboard.

## Reliability

### Ledger

Every send writes a `notifications` row **before** the provider is called:

- `kind`, `channel`, `recipient`, `subject`, `body` — what was attempted
- `status` — `queued` → `sent` | `failed`
- `attempts` — how many times the provider was called
- `providerRef` — Resend message id / Twilio message sid, for tracing a
  delivery in the provider's dashboard
- `lastError`, `nextAttemptAt`, `sentAt`, `createdAt`, `updatedAt`

### Idempotency

The unique `idempotencyKey` index is what makes duplicate events harmless. A
duplicate webhook, double-click or retried server action finds the existing
row and sends nothing — including when the first attempt **failed**: retries
belong to the retry sweep, not to whatever event happened to arrive twice.

### Retries

`retryFailedNotifications` (part of the daily cron) re-attempts every `failed`
row whose backoff has elapsed, up to `MAX_ATTEMPTS = 5`:

| Attempt | 1 | 2 | 3 | 4 | 5 |
|---|---|---|---|---|---|
| Delay | 1 min | 5 min | 15 min | 1 h | 6 h |

Each row is re-claimed with a conditional update (`status = 'failed' AND
attempts < 5`), so overlapping sweeps cannot double-send. After five failures
a row stays `failed` for humans to look at.

### Duplicate prevention — checklist

- duplicate event → same idempotency key → no second send
- concurrent reminder sweeps → unique index claims the row first
- provider timeout → ledger row stays `queued`… note: a send whose *result*
  write failed (DB hiccup after the provider accepted) stays `queued` and is
  not retried; it is visible in the ledger for manual inspection.

### Content safety

No notification — email or SMS — ever quotes the patient's free-text
appointment reason, which is medical content. This is enforced by test
(`lib/notifications/__tests__/preferences.test.ts`).

## User preferences

The patient dashboard's "Notification preferences" card (`components/
notification-preferences.tsx`, action in `actions/notifications.ts`) controls:

- **Email updates** — on by default; transactional mail to the sign-in address.
- **SMS updates** — off by default. Requires both a stored mobile number and a
  dated consent tick; disabling clears the consent so a later re-enable needs
  a fresh, dated one.
- **Marketing opt-in** — reserved for optional promotional communication; no
  marketing message is sent today. Appointment messages never depend on it.

Guard rails (re-validated server-side): at least one channel must stay
reachable, and SMS needs number + consent. A patient who disables everything
still sees every update on their dashboard, which is the source of truth.

## Operations

### Cron

`GET /api/cron/daily-sweep` (Vercel Cron, authenticated with
`Authorization: Bearer $CRON_SECRET`) runs three independent sweeps and
reports each one separately:

1. `releaseExpiredPayments` — free slots held by abandoned checkouts
2. `sweepReminders` — send due reminders
3. `retryFailedNotifications` — retry failed sends past their backoff

Vercel Hobby allows daily schedules only; the dashboard-render triggers cover
the gap during the day. On a Pro plan the cron can run every minute for
tighter reminder timing (`vercel.json`).

### Checking delivery health

```sql
-- Recent failures, newest first
SELECT id, kind, channel, recipient, attempts, last_error, created_at
FROM notifications
WHERE status = 'failed'
ORDER BY created_at DESC
LIMIT 50;

-- Anything stuck queued (provider accepted but the result write failed)
SELECT * FROM notifications WHERE status = 'queued' AND created_at < now() - interval '1 hour';

-- Delivery rate by kind
SELECT kind, status, count(*) FROM notifications GROUP BY 1, 2 ORDER BY 1, 2;
```

To trace a specific delivery in the provider dashboard, copy its
`provider_ref` (Resend → Emails, or Twilio → Messaging → Logs).

### Forcing a retry

The retry sweep honours `next_attempt_at`; to retry sooner:

```sql
UPDATE notifications SET next_attempt_at = now() WHERE id = <row id>;
```

(and trigger the sweep, or wait for the next daily run). To abandon a
poisoned address permanently:

```sql
UPDATE notifications SET attempts = 5, next_attempt_at = NULL WHERE id = <row id>;
```

### Local development

No keys needed: without `RESEND_API_KEY` email is printed to the server log
(`[notification] {…}`), and without Twilio vars SMS attempts are recorded as
skipped. The full pipeline — ledger, idempotency, retries — runs unchanged.

### Known limits / next steps

- Doctor-level leave management does not exist yet; when a doctor cancels a
  booked appointment the patient receives the clinic-cancelled notification.
  A bulk "doctor is on leave, cancel these visits" flow would reuse
  `cancelAppointment`'s notification path per visit.
- Reminder windows are constants in `reminders.ts`, not env-configurable.
- Marketing messages are consent-flagged but not implemented.

## Tests

```bash
npm test
```

Coverage today: dispatch idempotency (send once per key; duplicate events and
previously-failed rows never re-send), retry sweep (backoff timing, attempt
cap, missing transport), `notify` never throwing (store failures reported as
non-delivery), preference gating (consent + phone required for SMS), the
Twilio transport (request shape, provider sid, rejection), the retry policy
table, and the PHI rule (no template quotes the appointment reason).

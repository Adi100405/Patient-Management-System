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
Resend (email) / Vonage or Twilio (SMS)    /api/cron/daily-sweep retries failures
```

Key files:

| File | Responsibility |
|---|---|
| `lib/notifications/templates/` | Pure message text and markup. One reviewable place for every patient-facing sentence. |
| `lib/notifications/email-layout.ts` | The shared HTML shell every email is rendered into. |
| `lib/notifications/links.ts` | Absolute dashboard / receipt URLs for email buttons. |
| `lib/notifications/context.ts` | One query that resolves everything a template needs. |
| `lib/notifications/events.ts` | Event entry points (`sendBookingConfirmation`, …). Safe to call from any transactional flow — they never throw. |
| `lib/notifications/preferences.ts` | Loads a patient's channel choices; pure gate `channelsFor()`. |
| `lib/notifications/dispatch.ts` | Send-once-then-record core, injected with store + transport (unit-tested without a DB). |
| `lib/notifications/store.ts` | Drizzle implementation of the ledger. |
| `lib/notifications/retry-policy.ts` | `MAX_ATTEMPTS` and the backoff table. |
| `lib/notifications/reminders.ts` | Reminder sweep (24h / 1h before the visit). |
| `lib/notifications/care.ts` | Post-visit care sweep (thank-you, follow-up prompt). |
| `lib/notifications/channels/` | Transports: `resend.ts`, `vonage.ts`, `twilio.ts` (SMS), `sms.ts` (picks the SMS provider), `log.ts`. |

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

### Mobile — SMS via Vonage or Twilio

Mobile messages are SMS. There is no second mobile channel: see
[WhatsApp was removed](#whatsapp-was-removed) below for why.

SMS has two possible providers — **Vonage** or **Twilio** — and the ledger does
not care which one carried a message. See
[SMS providers](#sms-providers-vonage-or-twilio) below.

| Env var | Required | Notes |
|---|---|---|
| `TWILIO_ACCOUNT_SID` | for Twilio SMS | From the Twilio console. |
| `TWILIO_AUTH_TOKEN` | for Twilio SMS | Paired auth token. |
| `TWILIO_FROM` | for Twilio SMS | An SMS-capable number or messaging service, E.164. Carries every kind. |
| `VONAGE_API_KEY` | for Vonage SMS | From the Vonage dashboard. |
| `VONAGE_API_SECRET` | for Vonage SMS | The paired secret. |
| `VONAGE_FROM` | for Vonage SMS | The sender: a number in E.164 (digits, no leading `+`) or an alphanumeric sender ID. A number is the safe choice on a free account — an alphanumeric ID has to be registered for the destination country, and India requires DLT registration. |

Setup:

1. **Vonage** — create an account at [dashboard.vonage.com](https://dashboard.vonage.com),
   copy the API key and secret, and set `VONAGE_API_KEY`, `VONAGE_API_SECRET`
   and `VONAGE_FROM`. A trial account sends only to the registered number and
   four verified test numbers, and appends `[FREE SMS DEMO, TEST MESSAGE]` to
   the body.
2. **Twilio** — create a number (or messaging service) and set
   `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN` and `TWILIO_FROM`.
3. Redeploy: environment changes only reach new builds.

Missing SMS configuration means the attempt is recorded as not delivered, never
faked. Indian numbers additionally require TRAI **DLT** registration (entity,
sender ID, templates), which no provider can skip.

### WhatsApp was removed

WhatsApp used to be a second mobile channel, carried by Twilio with an
approved Content Template (`ContentSid` + `ContentVariables`, never a
free-form body). It is gone, for a reason worth recording:

- **A WhatsApp send needs a Meta-approved template.** Business-initiated
  messages are template-only; a free-form body is rejected whenever the
  recipient's 24-hour window is closed.
- **The only template this project could use was a fixed body that ignored the
  appointment date.** Twilio's trial template rendered
  `Reminder: Appt Tue Oct 29, 3:00 PM…` whatever the real visit was, so a
  booking could have gone out with the wrong day on it — the kind of message
  that is worse than no message.
- **The account cannot create its own template.** Twilio's Content API answers
  `20003 This feature is not available on a Trial account`, and a production
  template needs Meta business verification, an approved display name, a
  dedicated number and a payment method — a multi-day onboarding that no
  code change can shorten.

Vonage was checked as an alternative and does not remove the wall: its
production WhatsApp is the same Meta onboarding with a Vonage platform fee on
top, and its free Messages API Sandbox only delivers to a number the operator
has allow-listed, so it cannot carry a real patient's appointment.

So mobile rides SMS, which carries the clinic's own words. Two traces of the
old channel remain, deliberately: the `notification_channel` enum still
contains `whatsapp` and the ledger's `content_variables` column still exists,
because rows written before the removal have to keep reading back. The retry
sweep finds no transport for that channel and leaves those rows alone rather
than re-sending them somewhere they were never addressed to.

### SMS providers: Vonage or Twilio

SMS is one channel with two possible providers, and the ledger's channel column
is `email | sms` — so switching provider needs no schema change and no
migration. The transport is chosen by what the environment carries, and
**Vonage wins when both are configured**.

| Provider | Trial account | Free-form body |
|---|---|---|
| **Vonage** | Yes — sends only to the registered number and four verified test numbers, and appends `[FREE SMS DEMO, TEST MESSAGE]` to the body | **Yes.** The clinic's own text reaches the handset. |
| **Twilio** | Yes — but a free-form body is refused outright with `572006`; only the name of one of Twilio's predefined templates is accepted | Only on a paid account. |

That difference is the whole reason Vonage exists here: on a free Twilio
account the clinic's message never reaches the patient, while a free Vonage
account carries it.

Vonage's wire format is one form-encoded POST to `rest.nexmo.com/sms/json`
carrying the API key, the API secret, the sender, the recipient and the text —
no SDK and no JWT. Numbers go out as bare digits, and a message containing `₹`
or an em dash is declared as `unicode` rather than plain GSM. Vonage answers
HTTP 200 even when it refuses a message, so the refusal is in the body: a
per-message `status` other than `"0"`, or a top-level `error-code` for an
authentication failure. Both are thrown, so the ledger records the failure
instead of claiming a delivery.

`/api/notifications/status` reports which provider would carry the next SMS:

```json
"sms": { "provider": "vonage", "configured": true, "sender": { "tail": "0000" },
         "trialFallback": false }
```

`trialFallback` is true only for Twilio: it marks the one case where a message
may go out as one of Twilio's predefined templates instead of the clinic's text.

### Trial accounts: predefined SMS templates (Twilio only)

This section is about the **Twilio** transport. On a Twilio trial account a
free-form SMS body is refused outright: the Messages API answers `572006
Invalid template name` unless `Body` is *exactly* the name of one of Twilio's
predefined templates, so the only text a trial can deliver is Twilio's own —
always suffixed `Test message from Twilio.` (A Vonage trial has no such limit;
see [SMS providers](#sms-providers-vonage-or-twilio).)

The transport keeps writing the clinic's real message and treats `572006` as
"this account is on trial": the send is retried once with the predefined
template closest to the event, and the server log names the substitution.

| Event | Predefined template |
|---|---|
| booked, rescheduled, cancelled, reminder, follow-up prompt | `sms_appointment_reminders` |
| payment confirmed | `sms_order_confirmation` |
| refund initiated / completed / failed | `sms_customer_support` |
| visit thanks | `sms_feedback_surveys` |
| anything unmapped | `sms_customer_support` |

A paid account never returns `572006`, so the fallback cannot fire there and
nothing has to be switched off after an upgrade. Until then the handset shows
Twilio's sentence rather than the clinic's: the ledger still records the text
the clinic meant to send, and `/api/notifications/status` reports
`sms.trialFallback: true`. The choice is deliberate — a delivery that says less
than intended, with a visible test suffix, beats a booking confirmation that
silently never arrives.

### Verifying what a deployment can see

"Mobile skipped" does not say whether the provider was unconfigured or the env
var never reached the build. Sign in to a **doctor** account and open:

```
GET /api/notifications/status
```

It answers with the deployment's environment, branch and commit; which
transports are configured; which SMS provider would carry the next message and
the sender's last four digits; and that mobile rides SMS. Only booleans and
the last four characters of the sender are returned — credentials never leave
the server.

A common false negative: env vars added in Vercel after a build do not reach
that build. Check the returned `deployment.commit` is the commit you expect,
then trigger a **new** deployment (a merge to `main` or Deployments → Redeploy)
and re-check.

Two more read-only views answer the questions a trial account cannot:

- `?messages=1` — Twilio's own message log for this account: what the SMS
  transport handed to the provider and how it was answered. Recipients are
  masked; message bodies are never returned.
- `?services=1` — the account's messaging services.

### Sending one message on demand

`POST /api/notifications/test-send` (doctor-only) sends one SMS through the
deployment's own credentials and reports what the provider answered. It exists
so "can this deployment deliver?" is answerable without booking an
appointment:

```json
{ "to": "+91XXXXXXXXXX", "text": "Medrella test SMS" }
```

The message goes through the same transport the appointment events use, so a
test exercises the same provider handling a real appointment message would get.
The answer names the provider, and on a trial Twilio account it shows the
predefined-template fallback in action (`degraded: true` plus the
`trialTemplate` Twilio chose) rather than claiming the clinic's text was
delivered. `text` is optional and defaults to a neutral sentence; `kind` picks
which event's template the Twilio trial maps to. Each SMS provider reads its
sender from the deployment's own configuration, so there is nothing to override
per request.

`"channel": "sms"` may be passed explicitly. Any other channel is refused with
a `400` — WhatsApp is no longer a channel in this app.

Every transport uses plain `fetch` with an 8-second timeout, so a hung provider
can never hold up a booking, payment or refund.

## Email rendering

Every email is delivered as `text` **and** `html`. Both come from the same
template in `templates.ts`, so the sentences are identical and only the
presentation differs — a client that cannot render HTML still gets the whole
message.

- The shell lives in `lib/notifications/email-layout.ts`:
  `renderEmail({ heading, intro, rows, cta, footnote })`. Templates supply
  content, never markup.
- Client-safe by construction: table layout, inline styles only, a 600px
  measure, no flex/grid, and no external images or web fonts — the wordmark is
  text, so clients that block images still show the brand.
- Every interpolated value is HTML-escaped, so a name or note can never inject
  markup.
- Buttons point at absolute URLs built in `lib/notifications/links.ts`, resolved
  from `APP_URL` → `VERCEL_URL` → `http://localhost:3000`. A payment
  confirmation links straight to its receipt; every other event links to the
  dashboard.
- The HTML body is stored on the ledger row (`html_body`), so the retry sweep
  re-sends the rich email instead of silently downgrading it to plain text.

## Events

| Event | When it fires | Idempotency key |
|---|---|---|
| Booking confirmed | A slot is booked (manual or online) | `booking_confirmed:<id>` |
| Payment confirmed | A capture is first recorded (checkout or webhook) | `payment_confirmed:<id>` |
| Appointment cancelled | Patient, doctor or expired checkout | `appointment_cancelled:<id>` |
| Appointment rescheduled | Slot move succeeds | `appointment_rescheduled:<id>:<old>→<new>` |
| Refund initiated / completed / failed | Refund state transitions | `refund_<stage>:<id>` |
| Reminder (24h / 1h) | Reminder sweep finds a due window | none — the `reminders` table owns reminder dedup |
| Visit thanks | Care sweep finds a recently completed visit | none — the `care_follow_ups` table owns dedup |
| Follow-up prompt | Care sweep finds a completed visit past its advised interval | none — the `care_follow_ups` table owns dedup |

Every event renders one email and, when the template has one and the patient
opted in, one short SMS. Each channel gets its own ledger row keyed
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

### Post-visit care loop

The visit does not end at the receipt. When a doctor resolves a visit
**completed**, they may optionally record, on the same form:

- **Aftercare instructions** — free text the patient sees on their dashboard.
- **Recommend a follow-up in (days)** — an interval, or blank for none.

Aftercare is medical content, so it is **never** copied into a message: the
thank-you email and mobile message only point the patient at their dashboard,
where the note lives. The same rule already protects the patient's free-text
reason, and the tests enforce both.

`sweepCareFollowUps` (`lib/notifications/care.ts`) then derives two messages
from live state — completed visits only — exactly as reminders do:

| Kind | Fires when |
|---|---|
| `visit_thanks` | 0–72 hours after the visit ends |
| `follow_up_prompt` | only when the doctor set an interval, within a 72-hour window after that interval elapses |

A follow-up prompt exists only when the doctor advised one, so the loop stays
silent rather than nagging on a guess. The `care_follow_ups` table's unique
`(appointment_id, kind)` index makes overlapping sweeps safe; a failed send
releases its claim so the next sweep retries. Triggers: the daily cron, and
opportunistically whenever a patient opens their dashboard.

## Reliability

### Ledger

Every send writes a `notifications` row **before** the provider is called:

- `kind`, `channel`, `recipient`, `subject`, `body`, `htmlBody` — what was attempted
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
appointment reason or the doctor's aftercare note, which are medical content.
This is enforced by test (`lib/notifications/__tests__/preferences.test.ts`).

## User preferences

The patient dashboard's "Notification preferences" card (`components/
notification-preferences.tsx`, action in `actions/notifications.ts`) controls:

- **Email updates** — on by default; transactional mail to the sign-in address.
- **Mobile updates** — off by default; sent by SMS. Requires both a stored
  mobile number and a dated consent tick; disabling clears the consent so a
  later re-enable needs a fresh, dated one.
- **Marketing opt-in** — reserved for optional promotional communication; no
  marketing message is sent today. Appointment messages never depend on it.

Guard rails (re-validated server-side): at least one channel must stay
reachable, and SMS needs number + consent. A patient who disables everything
still sees every update on their dashboard, which is the source of truth.

## Operations

### Cron

`GET /api/cron/daily-sweep` (Vercel Cron, authenticated with
`Authorization: Bearer $CRON_SECRET`) runs four independent sweeps and
reports each one separately:

1. `releaseExpiredPayments` — free slots held by abandoned checkouts
2. `sweepReminders` — send due reminders
3. `sweepCareFollowUps` — send due post-visit care messages
4. `retryFailedNotifications` — retry failed sends past their backoff

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
(`[notification] {…}`), and without Vonage or Twilio vars SMS attempts are
recorded as skipped. The full pipeline — ledger, idempotency, retries — runs
unchanged.

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
cap, missing transport, that a retried send keeps its HTML body, and that a
row left over from the removed WhatsApp channel is never re-sent), `notify`
never throwing (store failures reported as non-delivery), preference gating
(consent + phone required for mobile messages), the Twilio SMS transport
(request shape, provider id, rejection, the trial-account fallback), the Vonage
SMS transport (request shape, digit-only numbers, `unicode` vs GSM, refusals),
the Resend transport (request shape, provider id, rejection), the email layout
(document shape, escaping, client-safety, preheader), the retry policy table,
post-visit care windows and aftercare parsing (`care.test.ts`), and the PHI rule
(no template quotes the appointment reason or aftercare — in text, HTML or a
mobile message).

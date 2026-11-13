# AI Assistant

A role-aware assistant on the patient and doctor dashboards. It answers from the
same appointments, schedules, seats, payments and visit notes the screens read -
never from mock data - and it can book, reschedule and cancel only through a
signed confirmation card the person taps.

This document covers the server side: the two routes, the tool surface, the
proposal token and the privacy rules. The dashboard widget, chat panel, voice
layer and language picker live in the stacked UI change (`components/assistant/`).

## Architecture at a glance

```
chat panel (browser)
      │  POST /api/assistant         message + last turns + language
      ▼
app/api/assistant/route.ts           session, rate limit, history sanitising
      │
      ▼
lib/assistant/llm.ts                 Groq chat completions (OpenAI-compatible)
      │  tool_calls
      ▼
lib/assistant/tools/execute.ts       role gate + argument parsing + error shaping
      │
      ├── doctor.ts / patient.ts     read helpers, dashboard query shapes
      └── propose.ts                 writes → signed proposal, never a write
      │
      ▼
{ reply, proposals[] }               card rendered in the chat

Confirm tapped
      │  POST /api/assistant/confirm  { token }
      ▼
app/api/assistant/confirm/route.ts   verify signature, expiry, identity, single use
      │  FormData
      ▼
actions/booking.ts                   bookAppointment / rescheduleAppointment /
                                     cancelAppointment - revalidate, seat race,
                                     notifications, refunds all unchanged
```

The important line is the last one: the confirm endpoint does not write an
appointment itself. It reconstructs the `FormData` the booking screen would have
submitted and calls the existing server action, so every guard the platform
already has applies to the assistant too.

## Configuration

| Variable | Required | Meaning |
|---|---|---|
| `GROQ_API_KEY` | yes | Without it `/api/assistant` answers `503` and says the assistant is not configured. Keys: <https://console.groq.com/keys> |
| `ASSISTANT_MODEL` | no | Defaults to `openai/gpt-oss-120b`, a function-calling model on Groq. It calls tools on follow-up turns (where the smaller qwen model used to describe a confirmation card it never created) and its tokenizer sends roughly a third fewer prompt tokens, which matters under Groq's free-tier token budget |
| `ASSISTANT_PROPOSAL_SECRET` | no | Signs proposal tokens. Defaults to `SESSION_SECRET`; set it separately to let session and proposal keys rotate independently |

Environment changes only reach new builds: redeploy after adding a key. A
preview deployment uses the preview database, so assistant bookings made there
stay off production.

## The chat endpoint

`POST /api/assistant` accepts `{ message, history?, language? }`.

- **Session first.** No signed session → `401`.
- **Rate limit.** 20 messages per user per minute, in memory per serverless
  instance. Exceeding it → `429` with a plain retry message.
- **Message cap.** 1–1500 characters; history is trimmed to the last 6 turns and
  800 characters per turn. The browser cannot widen the context it sends.
- **Language.** `en`, `hi` or `hinglish`; the prompt names the reply language so
  the model answers accordingly. Unknown values fall back to English.
- **Tool loop.** At most 4 model passes per message. A `tool_calls` response is
  executed server-side; the model sees each result (bounded to 1800 characters)
  and produces the final speakable reply.
- **Model failures.** A Groq rate limit (429) → `429` with `retryAfterSeconds`
  and a `Retry-After` header, so the browser can say when to try again. Any
  other Groq error or timeout (20 s) → `502`. A tool failure is returned to the
  model as `{ error }` so it can explain rather than crash.
- **Quick answers.** When the model is unavailable, the endpoint answers the
  dashboard-level reads (appointments, payments, prescriptions, doctor search,
  and the doctor's day, counters, availability, conflicts and next slot) from
  the database and marks the reply `busy: true`. It never answers a write that
  way: booking, rescheduling and cancelling still need the model to prepare the
  proposal.
- **Card guard.** A reply may only describe a confirmation card the server
  actually minted, and may only say a write happened after the person taps
  Confirm. A reply that breaks either rule is replaced with an honest line.

The browser receives only `{ reply, proposals, busy?, retryAfterSeconds? }`. Raw
tool results - including patient names, phones and visit rows - never leave the
server.

## Tool catalog

Tools are thin wrappers. They reuse `blocksForDoctor`, `offersFor`,
`takenSeatsByTime`, `clinicNow`/`upcomingDays` and the dashboards' own join and
counter shapes, so the assistant and the screen cannot disagree about a slot.

### Doctor

| Tool | Answers | Built on |
|---|---|---|
| `appointments_for_date` | "who is coming in today", one date's schedule | doctor-dashboard join, FIFO order |
| `appointment_stats` | booked today, upcoming, patients seen, no-shows, completed, cancelled | dashboard `count(*) filter` query |
| `availability_overview` | published windows, hours, capacity, closed flags | `blocksForDoctor` |
| `detect_conflicts` | overlapping windows, using the edit-form rule | `blocksConflict` |
| `suggest_reschedule_slots` | free alternatives near one booking | `offersFor` + taken seats |
| `next_available_slot` | first free slots over the next week | `offersFor` |
| `today_summary` | counters plus today's visit list in one call | both shapes above |

### Patient

| Tool | Answers | Built on |
|---|---|---|
| `my_appointments` | upcoming live visits or past/cancelled history | patient-dashboard query, `needs_rebooking` included |
| `search_doctors` | doctor directory by name or specialization | `ilike` name/specialization search; a name typed in another script widens to the name's words and then to the directory, so the model can match the name itself |
| `available_slots` | what is bookable for a doctor on a date | `offersFor` + `takenSeatsByTime` |
| `suggest_alternatives` | free slots near a wanted time | same-day then next-week offers |
| `propose_booking` | a booking confirmation card | `signProposal` |
| `propose_reschedule` | a move confirmation card | `signProposal` |
| `propose_cancel` | a cancellation confirmation card | `signProposal` |
| `my_payments_and_refunds` | payments with refund status | `payments` + `refunds` |
| `my_prescriptions` | aftercare on the patient's own completed visits | `visit_notes` |

Role isolation is enforced at the dispatch table, not just in the prompt: a
tool name outside the session's role returns an ordinary error result. A patient
who hand-crafts a request still has no doctor handler to reach.

## Proposals: how a write happens

1. A `propose_*` tool checks the current state (the slot is free, the appointment
   is the patient's and still live) and returns a **proposal**:
   `{ action, args, userId, role }` signed with HS256, a random `jti`, and a
   five-minute expiry. Nothing is written.
2. The chat renders the proposal as a confirmation card: what will happen, with
   whom, when and the fee or refund line. The card carries the token, not the
   arguments; the browser cannot retype a price or a time.
3. On Confirm, `/api/assistant/confirm` verifies the signature and expiry,
   checks `userId` and `role` against the signed session, then spends the `jti`
   through an in-memory single-use registry. A second tap gets `409`, never a
   second write.
4. The route builds `FormData` from the signed arguments and calls
   `bookAppointment`, `rescheduleAppointment` or `cancelAppointment`. Those
   actions re-check the slot, retry the seat race, revalidate the dashboards and
   send the notifications. A failure (slot taken while the card was open) comes
   back as `422` with the action's own wording; the card is spent, and asking
   again mints a fresh proposal against fresh state.
5. A booking result with `payment.online: true` returns the fee and appointment
   id; the UI renders the existing Razorpay checkout inline. A cancellation is
   confirmed by re-reading the status row, because the cancel action is silent on
   refusals by design.

Expired or tampered tokens are refused without distinguishing which - a
five-minute-old card and a forged one deserve the same answer. Identity lives
inside the signature and is compared with the session again at confirm time.

## Security and privacy

- **Least authority.** Tools run with `{ userId, role, profileId }` taken from
  the signed session, never the request body. Every query is filtered by that
  `profileId`, matching the dashboard scoping.
- **PHI shaping.** Phone numbers are masked to the last four digits. Visit
  `reason` and `aftercare` are omitted from summaries; the only tool that returns
  aftercare text is `my_prescriptions`, limited to the patient's own completed
  visits, because that is the feature the patient asked for. Other patients'
  details never enter a doctor's tool result beyond the booking the dashboard
  already shows.
- **No invented facts.** The prompt forbids inventing doctors, slots, fees,
  statuses or patients; slot answers must come from `available_slots` or
  `suggest_alternatives`. The model has no write tool - only propose tools.
- **Speakable replies.** One to three plain sentences, no markdown, no URLs,
  because the same text may be read by text-to-speech.
- **Honest failures.** Unconfigured → `503`, model unavailable → `502`, stale
  proposal → `410`, spent proposal → `409`, action refusal → `422` with the
  action's message. The assistant never reports a write it did not make.

## Testing

The pure layers are unit-tested without a database, browser or model:

- `lib/assistant/__tests__/propose.test.ts` - round-trip, tampering, expiry,
  single use.
- `lib/assistant/__tests__/prompt.test.ts` - role audience, language directive,
  confirm-before-write rule, clinic date.

The whole project runs `npm test`, `npm run typecheck`, `npm run lint` and
`npm run build`. The LLM client accepts an injectable `fetchImpl` - the same
pattern as the Resend transport - so request shaping can be tested against a
fake Groq without a key.

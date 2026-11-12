# Password reset

How a patient takes their account back when they can't sign in: the flow, the
token's guarantees, what a reset means for live sessions, and how to operate it.

## Flow at a glance

```
/forgot-password          email form
        │
        ▼
forgotPasswordAction      looks up the user, honours the 60s cooldown,
        │                 deletes older requests, mints a fresh token,
        │                 stores only its sha256 digest
        ▼
sendPasswordResetEmail    generic response regardless of account existence
        │                 (the email itself is the only channel that knows)
        ▼
inbox                     link → /reset-password?token=…      (credential, 60 min, single-use)
        │
        ▼
resetPasswordAction       CAS-claims the token (used_at), bcrypt-hashes the
        │                 new password, stamps users.password_changed_at,
        │                 mails the tamper-alarm confirmation
        ▼
/sign-in?reset=1          every session issued before the change is now dead
```

## Key files

| File | Responsibility |
|---|---|
| `lib/password.ts` | Pure token domain: minting, digest, lifetime, usability, session staleness. No DB, no clock — unit-tested without a Postgres. |
| `db/schema.ts` | `password_reset_tokens` (digest only, unique) and `users.password_changed_at`. |
| `lib/auth.ts` | Boundary schemas (`forgotPasswordSchema`, `resetPasswordSchema`). |
| `actions/auth.ts` | `forgotPasswordAction` / `resetPasswordAction` — the entire server-side flow. |
| `lib/notifications/events.ts` | `sendPasswordResetEmail` / `sendPasswordChangedEmail` ride the notification ledger. |
| `app/forgot-password/page.tsx`, `app/reset-password/page.tsx` | The two screens; the reset page refuses tokens that never arrived. |

## Token guarantees

1. **Unguessable** — 32 random bytes, unpadded base64url (43 characters), so it
   can ride a query string unescaped.
2. **Stored only as a digest** — the `password_reset_tokens` row carries the
   sha256 hex of the token; a read of the table cannot mint a usable link.
   (The emailed body necessarily carries the link; that is the credential's
   one legitimate copy.)
3. **Single-use** — `used_at` is claimed by a conditional update
   (`WHERE used_at IS NULL`). Two tabs racing one link, a double click or a
   replayed submission resolve to exactly one password change.
4. **Hour-limited** — `RESET_TOKEN_TTL_MINUTES = 60`; expiry is inclusive.
5. **Latest wins** — minting a link deletes the account's older rows, so an
   inbox holds at most one live credential.

## Email protection, not inbox protection

The forgot-password form answers with the same sentence whether or not the
email belongs to an account: confirming which emails exist is exactly what a
public reset form must not confirm. The email itself still goes out only when
the account exists — the reset link inside assumes the reader controls the
inbox.

A **60-second request cooldown** (`RESET_REQUEST_COOLDOWN_MS`, keyed on the
account's newest request, used or not) keeps the form from being turned into a
mailer bomb. The form's response does not change during a cooldown.

## What a reset means for sessions

`users.password_changed_at` is the account's trust epoch. `requireSession()`
compares a session's JWT `iat` against it and routes anything older to
`/api/session/clear`, which deletes the cookie and lands on
`/sign-in?expired=1`. So after a reset:

- the patient's other browser sessions are signed out automatically,
- the browser that typed the new password signs in fresh (`/sign-in?reset=1`
  shows the success banner),
- an attacker holding only an old session token gains nothing.

Long-lived tokens without an `iat` (theoretically impossible via jose, but
guarded anyway) are treated as stale, not trusted.

## Channels and preferences

Reset emails ride `notify()` on the email channel and **bypass channel
preferences** — a patient who switched email updates off still gets their
reset link, and "your password was changed" is a tamper alarm, not a
preference. Neither message has a phone variant. Both WhatsApp-free.

## Operations

- Without `RESEND_API_KEY`, email degrades to the log channel: the flow still
  works end-to-end in dev, with the link printed where the email would land.
- If a send fails, the notification ledger keeps the row and the daily sweep
  retries it with backoff. The ledger row stores the message that was sent,
  including the link — but a retried link is usually already expired or
  replaced; the honest recovery is "request a fresh link".
- `notifications` rows for kind `password_reset` / `password_changed` are the
  audit trail — there is no appointment context on them, by design.

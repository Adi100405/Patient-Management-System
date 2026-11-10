import { renderEmail } from "../email-layout";
import type { MailContent } from "./shared";

/**
 * The two messages of the reset loop, written without any appointment
 * context — the shell's appointment footer is overridden with an account
 * footer, since a password is not an appointment. The reset link lives only
 * in the message body: it is the credential, and nothing else renders it.
 */

const ACCOUNT_FOOTER_NOTE = "This is an automated message about your Medrella account. Please do not reply to it.";

/**
 * The reminder that makes a wrong (or hostile) request harmless: without it,
 * the untouched password was never at risk, and this link simply expires.
 */
const NOT_YOU_LINE =
  "If you didn't request this, your account is safe — your current password still works, and this link will simply expire unused.";

/** The "send me a reset link" email. Carries and explains the token. */
export function passwordResetRequest(options: {
  resetUrl: string;
  expiryMinutes: number;
}): MailContent {
  const expiryLine = `The link works once and expires in ${options.expiryMinutes} minutes.`;

  return {
    subject: "Reset your Medrella password",
    text:
      [
        "Hi,",
        "We received a request to reset the password for your Medrella account.",
        `Open this link to choose a new password: ${options.resetUrl}`,
        expiryLine,
        NOT_YOU_LINE,
      ].join("\n") + "\n",
    html: renderEmail({
      heading: "Reset your password",
      intro: "We received a request to reset the password for your Medrella account.",
      cta: { label: "Choose a new password", url: options.resetUrl },
      footnote: `${expiryLine} ${NOT_YOU_LINE}`,
      footerNote: ACCOUNT_FOOTER_NOTE,
    }),
  };
}

/**
 * The confirmation after a password change — the heads-up that makes an
 * unauthorised change visible. Sessions issued before the change were
 * already signed out of every browser; the new password is now the only key
 * to the account.
 */
export function passwordChanged(): MailContent {
  const wasntYouLine =
    "Wasn't you? Other sign-ins were already signed out just now, but the new password opens the account — contact support right away.";

  return {
    subject: "Your Medrella password was changed",
    text:
      [
        "Hi,",
        "The password for your Medrella account was just changed.",
        "Sign in with the new password next time — your previous password no longer works.",
        wasntYouLine,
      ].join("\n") + "\n",
    html: renderEmail({
      heading: "Your password was changed",
      intro: "The password for your Medrella account was just changed. Sign in with the new password next time.",
      footnote: wasntYouLine,
      footerNote: ACCOUNT_FOOTER_NOTE,
    }),
  };
}

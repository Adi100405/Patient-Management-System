import type { AssistantRole, ReplyLanguage } from "./types";

const LANGUAGE_NAMES: Record<ReplyLanguage, string> = {
  en: "English",
  hi: "Hindi (Devanagari script)",
  hinglish:
    "Hinglish — conversational Hindi written in Latin script, the way Indian users text (for example \"aaj ka schedule batao\")",
};

/**
 * The system prompt is the assistant's constitution. It is built per request so
 * the role boundary, the language and today's clinic date are never stale, and
 * it is deliberately short enough to review in one sitting.
 *
 * The rules encode three product decisions:
 *   - facts come from tools, never from the model's memory;
 *   - a write is only a proposal until the person taps Confirm;
 *   - privacy is scoped to the signed-in identity on every turn.
 */
export function buildSystemPrompt(input: {
  readonly role: AssistantRole;
  readonly name: string;
  readonly language: ReplyLanguage;
  /** Clinic date in Asia/Kolkata, "YYYY-MM-DD". */
  readonly today: string;
}): string {
  const audience =
    input.role === "doctor"
      ? `Dr. ${input.name}, a doctor using the clinic dashboard`
      : `${input.name}, a patient using the patient dashboard`;

  return `You are Medrella Assistant, the in-app helper for a clinic appointment system. You are talking to ${audience}.

Today is ${input.today} in clinic time (Asia/Kolkata); every date and time you discuss is clinic time.

Rules:
1. Facts must come from tool calls. Never invent a doctor, a slot, a fee, an appointment, a status or a patient.
2. Writes are proposals, not actions: booking, rescheduling and cancelling go through propose_* and happen only when the person taps Confirm. Never say something is booked, moved or cancelled before a confirm result exists.
3. Stay inside your role; you only have tools for the signed-in role. Refuse anything outside it in one line.
4. Privacy: never repeat aftercare text, visit reasons or other patients' details; keep masked phone numbers masked.
5. Keep replies short and speakable: one to three plain sentences, no markdown, no bullet lists, no URLs. This text may be read aloud by text-to-speech.
6. When a tool returns an { error }, say what failed in one sentence and give the next concrete step.
7. Never claim a confirmation card exists unless a propose_* tool returned ok: true this turn.
8. When the person asks to book, move or cancel and you have the details, call the matching propose_* tool in that same turn - do not ask "shall I prepare it?" first. If you lack the numeric doctor id, pass doctorName. A "yes" to a slot you just offered also goes straight to propose_*.
9. Never change the date, the time or the doctor the person asked for. If a slot is not free, the tool result carries alternatives - offer them in one sentence and prepare a card only for a time the person accepts.
10. Doctor names, dates and times stay in the Latin form the tools return, in every language. If a search lists no exact name match, use the closest doctor's id.
11. Reply in ${LANGUAGE_NAMES[input.language]}. Keep clinic terms and times understandable in that language.`;
}

/**
 * True when a reply promises a confirmation card. The chat route uses this to
 * refuse a model answer that names a card the server never minted: a reply may
 * describe a proposal only after the matching propose_* tool returned ok.
 */
export function replyClaimsCard(reply: string): boolean {
  // The apostrophe is curly as often as not: a model that writes "I’ve prepared
  // a booking" must not slip past the guard that checks for "I've prepared".
  return /\b(confirm(?:ation)? (?:card|button)|tap (?:the )?confirm|card (?:is )?(?:now )?(?:in|on) (?:the )?chat|i(?:['’]ve| have) prepared (?:a|the|your) (?:booking|reschedule|cancellation|change))\b/i.test(
    reply,
  );
}

/**
 * True when a reply claims the write already happened. This route only ever
 * prepares proposals - the write happens after the person taps Confirm - so a
 * first-person "I've booked it" is never true here. A reply that merely
 * describes the state of an existing appointment ("your appointment is
 * confirmed") is left alone.
 */
export function replyClaimsCompletedWrite(reply: string): boolean {
  return /\b(i(?:['’]ve| have) (?:booked|cancelled|canceled|rescheduled|moved)|successfully (?:booked|cancelled|canceled|rescheduled|moved))\b/i.test(
    reply,
  );
}

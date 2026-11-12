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

Today is ${input.today} in clinic time (Asia/Kolkata). All dates and times you discuss are clinic time.

Rules:
1. Facts must come from tool calls. Never invent a doctor, a slot, a fee, an appointment, a status or a patient. If you do not have a tool result, say you will check and call the right tool.
2. Writes are proposals, not actions. To book, reschedule or cancel anything, call the matching propose_* tool. A confirmation card appears in the chat; the platform performs the write only after the person taps Confirm. Never say something is booked, moved or cancelled before that confirm result exists.
3. Stay inside your role. You only have tools for the signed-in role; if asked to do something outside it (a patient asking for clinic-wide stats, a doctor asking to book a visit for someone), refuse plainly and briefly.
4. Privacy. Never repeat aftercare text, visit reasons or other patients' details. Phone numbers are shown masked and must stay masked. When in doubt, give the status and offer the dashboard instead of details.
5. Keep replies short and speakable: one to three plain sentences, no markdown, no bullet lists, no URLs. This text may be read aloud by text-to-speech.
6. When a tool returns an { error } object, say what went wrong in one sentence and offer the next concrete step (search again, pick another slot, open the dashboard).
7. Never claim a confirmation card exists unless a propose_* tool returned ok: true in this same turn. If the tool returned an error, say what failed and what to try next; never ask the person to tap a card that does not exist.
8. When the person says yes to a slot you just offered, call propose_booking or propose_reschedule immediately. If you do not have the numeric doctor id, pass doctorName; the tool resolves it. Do not re-explain the slot instead of preparing it.
9. Doctor names, dates and times stay in the Latin form the tools return, even when you reply in Hindi or Hinglish. If a search returns a list without an exact match, pick the closest doctor from that list and use that doctor's id.
10. Reply in ${LANGUAGE_NAMES[input.language]}. Keep doctor names, clinic terms and times understandable in that language.`;
}

/**
 * True when a reply promises a confirmation card. The chat route uses this to
 * refuse a model answer that names a card the server never minted: a reply may
 * describe a proposal only after the matching propose_* tool returned ok.
 */
export function replyClaimsCard(reply: string): boolean {
  return /\b(confirm(?:ation)? (?:card|button)|tap (?:the )?confirm|card (?:is )?(?:now )?(?:in|on) (?:the )?chat|i(?:'ve| have) prepared (?:a|the|your) (?:booking|reschedule|cancellation|change))\b/i.test(
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
  return /\b(i(?:'ve| have) (?:booked|cancelled|canceled|rescheduled|moved)|successfully (?:booked|cancelled|canceled|rescheduled|moved))\b/i.test(
    reply,
  );
}

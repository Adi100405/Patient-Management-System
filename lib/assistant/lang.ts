import type { ReplyLanguage } from "./types";

/**
 * The three reply languages, and the two browser locales each one needs.
 *
 * Recognition and synthesis use different locale strings on purpose:
 *   - Hinglish is Hindi written in Latin script, so recognition runs on the
 *     Indian English locale (it transcribes Latin letters) while the prompt asks
 *     the model to answer in conversational Hinglish.
 *   - Hindi runs end-to-end on `hi-IN`, including Devanagari synthesis.
 *   - English uses the Indian English locale so doctor names and clinic wording
 *     sound right rather than American.
 */
export type LanguageOption = {
  readonly id: ReplyLanguage;
  /** The name shown in the picker. */
  readonly label: string;
  /** Two-letter mark for tight spaces. */
  readonly short: string;
  /** BCP-47 locale for SpeechRecognition. */
  readonly recognition: string;
  /** BCP-47 locale for SpeechSynthesis. */
  readonly speech: string;
};

export const LANGUAGE_OPTIONS: readonly LanguageOption[] = [
  { id: "en", label: "English", short: "EN", recognition: "en-IN", speech: "en-IN" },
  { id: "hi", label: "हिंदी", short: "हिं", recognition: "hi-IN", speech: "hi-IN" },
  { id: "hinglish", label: "Hinglish", short: "HI", recognition: "en-IN", speech: "en-IN" },
];

export const LANGUAGE_STORAGE_KEY = "medrella.assistant.language";

export function isReplyLanguage(value: unknown): value is ReplyLanguage {
  return value === "en" || value === "hi" || value === "hinglish";
}

export function languageOption(id: ReplyLanguage): LanguageOption {
  return LANGUAGE_OPTIONS.find((option) => option.id === id) ?? LANGUAGE_OPTIONS[0]!;
}

export function recognitionLang(id: ReplyLanguage): string {
  return languageOption(id).recognition;
}

export function speechLang(id: ReplyLanguage): string {
  return languageOption(id).speech;
}

/**
 * Reads the saved language without assuming a browser exists. The caller passes
 * `window.localStorage` on the client; tests pass a fake.
 */
export function readStoredLanguage(storage: Pick<Storage, "getItem"> | null): ReplyLanguage {
  if (!storage) return "en";
  try {
    const saved = storage.getItem(LANGUAGE_STORAGE_KEY);
    return isReplyLanguage(saved) ? saved : "en";
  } catch {
    return "en";
  }
}

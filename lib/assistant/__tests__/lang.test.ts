import { describe, expect, it } from "vitest";
import {
  LANGUAGE_OPTIONS,
  LANGUAGE_STORAGE_KEY,
  isReplyLanguage,
  languageOption,
  readStoredLanguage,
  recognitionLang,
  speechLang,
} from "@/lib/assistant/lang";

describe("assistant languages", () => {
  it("offers exactly English, Hindi and Hinglish", () => {
    expect(LANGUAGE_OPTIONS.map((option) => option.id)).toEqual(["en", "hi", "hinglish"]);
    expect(LANGUAGE_OPTIONS.map((option) => option.label)).toEqual(["English", "हिंदी", "Hinglish"]);
  });

  it("recognises a valid stored language and rejects anything else", () => {
    expect(isReplyLanguage("hi")).toBe(true);
    expect(isReplyLanguage("hinglish")).toBe(true);
    expect(isReplyLanguage("fr")).toBe(false);
    expect(isReplyLanguage(null)).toBe(false);
  });

  it("uses Indian locales so names and clinic wording sound right", () => {
    expect(recognitionLang("en")).toBe("en-IN");
    expect(recognitionLang("hi")).toBe("hi-IN");
    // Hinglish is Latin-script Hindi, so recognition stays on Indian English.
    expect(recognitionLang("hinglish")).toBe("en-IN");
    expect(speechLang("hi")).toBe("hi-IN");
    expect(speechLang("en")).toBe("en-IN");
  });

  it("falls back to English for an unknown id", () => {
    expect(languageOption("en").label).toBe("English");
  });

  it("reads a saved choice without throwing on unavailable storage", () => {
    expect(readStoredLanguage(null)).toBe("en");
    expect(readStoredLanguage({ getItem: () => "hi" })).toBe("hi");
    expect(readStoredLanguage({ getItem: () => "klingon" })).toBe("en");
    expect(
      readStoredLanguage({
        getItem: () => {
          throw new Error("storage disabled");
        },
      }),
    ).toBe("en");
    expect(LANGUAGE_STORAGE_KEY).toBe("medrella.assistant.language");
  });
});

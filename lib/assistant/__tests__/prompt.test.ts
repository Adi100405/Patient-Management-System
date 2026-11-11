import { describe, expect, it } from "vitest";
import { buildSystemPrompt } from "@/lib/assistant/prompt";

const today = "2026-11-11";

describe("assistant system prompt", () => {
  it("names the doctor audience and the doctor's own dashboard", () => {
    const prompt = buildSystemPrompt({
      role: "doctor",
      name: "Aarav Mehta",
      language: "en",
      today,
    });

    expect(prompt).toContain("Dr. Aarav Mehta");
    expect(prompt).toContain("clinic dashboard");
    expect(prompt).not.toContain("patient dashboard");
  });

  it("names the patient audience without inventing a title", () => {
    const prompt = buildSystemPrompt({
      role: "patient",
      name: "Riya Sharma",
      language: "en",
      today,
    });

    expect(prompt).toContain("Riya Sharma, a patient");
    expect(prompt).not.toContain("Dr. Riya Sharma");
  });

  it("carries today's clinic date into every request", () => {
    const prompt = buildSystemPrompt({
      role: "patient",
      name: "Riya Sharma",
      language: "en",
      today,
    });

    expect(prompt).toContain(today);
    expect(prompt).toContain("Asia/Kolkata");
  });

  it("states the confirm-before-write rule in words the model cannot miss", () => {
    const prompt = buildSystemPrompt({
      role: "patient",
      name: "Riya Sharma",
      language: "en",
      today,
    });

    expect(prompt).toContain("Writes are proposals, not actions");
    expect(prompt).toContain("taps Confirm");
    expect(prompt).toContain("Never say something is booked");
  });

  it("grounds facts in tool results instead of model memory", () => {
    const prompt = buildSystemPrompt({
      role: "doctor",
      name: "Aarav Mehta",
      language: "en",
      today,
    });

    expect(prompt).toContain("Facts must come from tool calls");
    expect(prompt).toContain("Never invent a doctor, a slot");
  });

  it("asks for the chosen language, including Hinglish in Latin script", () => {
    const hindi = buildSystemPrompt({
      role: "patient",
      name: "Riya Sharma",
      language: "hi",
      today,
    });
    const hinglish = buildSystemPrompt({
      role: "patient",
      name: "Riya Sharma",
      language: "hinglish",
      today,
    });

    expect(hindi).toContain("Hindi (Devanagari script)");
    expect(hinglish).toContain("Hinglish");
    expect(hinglish).toContain("Latin script");
    expect(hinglish).toContain("aaj ka schedule batao");
  });

  it("keeps the reply speakable for text-to-speech", () => {
    const prompt = buildSystemPrompt({
      role: "doctor",
      name: "Aarav Mehta",
      language: "en",
      today,
    });

    expect(prompt).toContain("no markdown");
    expect(prompt).toContain("read aloud");
  });
});

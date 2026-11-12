import { describe, expect, it } from "vitest";
import {
  buildSystemPrompt,
  replyClaimsCard,
  replyClaimsCompletedWrite,
} from "@/lib/assistant/prompt";
import {
  classifyFallbackIntent,
  formatFallbackReply,
  planFor,
  type FallbackPlan,
} from "@/lib/assistant/fallback";
import { nameMatchPatterns, toClinicTime } from "@/lib/assistant/tools/shared";

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

  it("prepares a requested booking in the same turn and never swaps the slot", () => {
    const prompt = buildSystemPrompt({
      role: "patient",
      name: "Riya Sharma",
      language: "en",
      today,
    });

    expect(prompt).toContain("call the matching propose_* tool in that same turn");
    expect(prompt).toContain("Never change the date, the time or the doctor");
    expect(prompt).toContain("call suggest_alternatives");
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

describe("assistant reply guards", () => {
  it("flags a reply that points at a confirmation card", () => {
    expect(replyClaimsCard("Please tap the confirmation card to continue.")).toBe(true);
  });

  it("flags a reply that says a booking was prepared", () => {
    expect(replyClaimsCard("I've prepared a booking for Dr. Aarav Mehta.")).toBe(true);
  });

  it("flags the same sentence with a curly apostrophe", () => {
    expect(replyClaimsCard("I’ve prepared a booking for Dr. Aarav Mehta.")).toBe(true);
  });

  it("leaves a reply that only reports an existing appointment alone", () => {
    expect(replyClaimsCard("Your appointment with Dr. Aarav Mehta is on Mon, 16 Nov.")).toBe(
      false,
    );
  });

  it("flags a reply that claims the write already happened", () => {
    expect(replyClaimsCompletedWrite("I've booked your visit for Mon, 16 Nov.")).toBe(true);
  });

  it("flags a completed-write claim with a curly apostrophe", () => {
    expect(replyClaimsCompletedWrite("I’ve booked your visit for Mon, 16 Nov.")).toBe(true);
  });

  it("leaves a reply that describes appointment state alone", () => {
    expect(replyClaimsCompletedWrite("Your appointment on Mon, 16 Nov is confirmed.")).toBe(false);
  });
});

describe("assistant clinic time parsing", () => {
  it("reads the time format people speak", () => {
    expect(toClinicTime("12:30 PM")).toBe("12:30");
    expect(toClinicTime("9:05")).toBe("09:05");
    expect(toClinicTime("12:05 am")).toBe("00:05");
    expect(toClinicTime("12.30 pm")).toBe("12:30");
  });

  it("refuses a time that is not on the clock", () => {
    expect(toClinicTime("25:00")).toBeNull();
    expect(toClinicTime("10:7")).toBeNull();
    expect(toClinicTime("after lunch")).toBeNull();
  });
});

describe("assistant doctor name matching", () => {
  it("matches a typed name by its words as well as by the whole phrase", () => {
    expect(nameMatchPatterns("Dr. Aarav Mehta")).toEqual([
      "Dr. Aarav Mehta",
      "Aarav",
      "Mehta",
    ]);
  });

  it("keeps a name typed in another script as its own pattern", () => {
    expect(nameMatchPatterns("डॉ. आरव मेहता")).toEqual([
      "डॉ. आरव मेहता",
      "आरव",
      "मेहता",
    ]);
  });

  it("drops words too short to be a name", () => {
    expect(nameMatchPatterns("Dr A")).toEqual(["Dr A"]);
  });

  it("returns nothing to match for an empty term", () => {
    expect(nameMatchPatterns("   ")).toEqual([]);
  });
});

describe("assistant fallback intents", () => {
  it("reads a patient's appointment question as an upcoming list", () => {
    expect(classifyFallbackIntent("patient", "What appointments do I have?")).toEqual({
      kind: "appointments",
      scope: "upcoming",
    });
  });

  it("reads a patient's history question as a past list", () => {
    expect(classifyFallbackIntent("patient", "show my previous visits")).toEqual({
      kind: "appointments",
      scope: "past",
    });
  });

  it("reads a payment question as payments", () => {
    expect(classifyFallbackIntent("patient", "what about my refund status")).toEqual({
      kind: "payments",
    });
  });

  it("reads a prescription question as prescriptions", () => {
    expect(classifyFallbackIntent("patient", "show my prescriptions")).toEqual({
      kind: "prescriptions",
    });
  });

  it("reads a speciality as a doctor search", () => {
    expect(classifyFallbackIntent("patient", "find a cardiologist")).toEqual({
      kind: "doctors",
      query: "cardiologist",
    });
  });

  it("refuses to plan a write for a patient", () => {
    expect(classifyFallbackIntent("patient", "book Dr. Aarav Mehta tomorrow")).toBeNull();
  });

  it("reads a doctor's day question", () => {
    expect(classifyFallbackIntent("doctor", "who is coming in today")).toEqual({ kind: "today" });
  });

  it("reads a doctor's statistics question", () => {
    expect(classifyFallbackIntent("doctor", "how many completed visits do I have")).toEqual({
      kind: "stats",
    });
  });

  it("reads a doctor's availability question", () => {
    expect(classifyFallbackIntent("doctor", "show my working hours")).toEqual({
      kind: "availability",
    });
  });

  it("reads a doctor's conflict question", () => {
    expect(classifyFallbackIntent("doctor", "any overlapping windows")).toEqual({
      kind: "conflicts",
    });
  });

  it("reads a doctor's next slot question", () => {
    expect(classifyFallbackIntent("doctor", "when is the next free slot")).toEqual({
      kind: "next_slot",
    });
  });
});

describe("assistant fallback plan", () => {
  it("answers a patient's appointment question with that patient's own list", () => {
    const intent = { kind: "appointments", scope: "upcoming" } as const;

    expect(planFor(intent)).toEqual({
      intent,
      tool: "my_appointments",
      args: { scope: "upcoming" },
    });
  });

  it("answers a doctor's day question with that doctor's own schedule", () => {
    expect(planFor({ kind: "today" })).toEqual({
      intent: { kind: "today" },
      tool: "appointments_for_date",
      args: {},
    });
  });
});

describe("assistant fallback replies", () => {
  const plan: FallbackPlan = planFor({ kind: "appointments", scope: "upcoming" });

  it("lists the patient's upcoming appointments", () => {
    const reply = formatFallbackReply(
      plan,
      {
        count: 2,
        appointments: [
          { doctorName: "Aarav Mehta", when: "Mon, 16 Nov, 12:00 PM", status: "booked" },
          { doctorName: "Priya Nair", when: "Fri, 20 Nov, 9:30 AM", status: "booked" },
        ],
      },
      "en",
    );

    expect(reply).toContain("2 upcoming appointments");
    expect(reply).toContain("Aarav Mehta (Mon, 16 Nov, 12:00 PM)");
    expect(reply).toContain("Priya Nair (Fri, 20 Nov, 9:30 AM)");
  });

  it("says there is nothing upcoming when the list is empty", () => {
    const reply = formatFallbackReply(plan, { count: 0, appointments: [] }, "en");

    expect(reply).toContain("no upcoming appointments");
  });

  it("marks the answer as a quick fallback when the model is busy", () => {
    const reply = formatFallbackReply(plan, { count: 0, appointments: [] }, "hinglish");

    expect(reply).toContain("busy");
  });

  it("refuses a result it cannot read instead of inventing one", () => {
    expect(formatFallbackReply(plan, { count: "two", appointments: [] }, "en")).toBeNull();
  });

  it("reports payments with their refund state", () => {
    const reply = formatFallbackReply(
      planFor({ kind: "payments" }),
      {
        payments: [
          {
            doctorName: "Aarav Mehta",
            dateLabel: "Mon, 16 Nov 12:00 PM",
            amount: "500.00",
            currency: "INR",
            status: "succeeded",
            refund: { amount: "500.00", status: "succeeded", note: null },
          },
        ],
      },
      "en",
    );

    expect(reply).toContain("Aarav Mehta");
    expect(reply).toContain("500 INR");
    expect(reply).toContain("succeeded");
    expect(reply).toContain("refund 500 succeeded");
  });

  it("keeps prescription text out of the quick fallback answer", () => {
    const reply = formatFallbackReply(
      planFor({ kind: "prescriptions" }),
      {
        prescriptions: [
          {
            doctorName: "Aarav Mehta",
            dateLabel: "Mon, 16 Nov 12:00 PM",
            aftercare: "One tablet after food",
            followUpDays: 7,
          },
        ],
      },
      "en",
    );

    expect(reply).toContain("Aarav Mehta");
    expect(reply).not.toContain("One tablet after food");
  });

  it("lists the doctor's day with patient names and times", () => {
    const reply = formatFallbackReply(
      planFor({ kind: "today" }),
      {
        date: "2026-11-11",
        appointments: [
          {
            id: 1,
            patientName: "Riya Sharma",
            patientPhone: "****7890",
            when: "Wed, 11 Nov, 10:30 AM",
            time: "10:30",
            status: "booked",
            seatNumber: 1,
            queuePosition: 1,
          },
        ],
      },
      "en",
    );

    expect(reply).toContain("1 visit today");
    expect(reply).toContain("Riya Sharma");
    expect(reply).toContain("10:30 AM");
  });

  it("reports the doctor's counters", () => {
    const reply = formatFallbackReply(
      planFor({ kind: "stats" }),
      {
        date: "2026-11-11",
        today: 3,
        upcoming: 5,
        patientsSeen: 12,
        noShows: 1,
        completed: 20,
        cancelled: 2,
      },
      "en",
    );

    expect(reply).toContain("3 booked today");
    expect(reply).toContain("5 upcoming");
    expect(reply).toContain("12 patients seen");
    expect(reply).toContain("1 no-shows");
    expect(reply).toContain("20 completed");
    expect(reply).toContain("2 cancelled");
  });

  it("reports the next free slot", () => {
    const reply = formatFallbackReply(
      planFor({ kind: "next_slot" }),
      {
        slots: [
          {
            date: "2026-11-12",
            time: "09:00",
            endTime: null,
            availabilityId: 3,
            schedulingType: "wave",
            free: 2,
          },
        ],
      },
      "en",
    );

    expect(reply).toContain("Thu, 12 Nov");
    expect(reply).toContain("9:00 AM");
  });

  it("says there is no conflict when the schedule is clean", () => {
    const reply = formatFallbackReply(planFor({ kind: "conflicts" }), { conflicts: [] }, "en");

    expect(reply).toContain("No schedule conflicts");
  });
});

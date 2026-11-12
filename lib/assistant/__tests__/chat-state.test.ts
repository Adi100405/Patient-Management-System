import { describe, expect, it } from "vitest";
import {
  MAX_HISTORY,
  activeProposals,
  addAssistantMessage,
  addUserMessage,
  emptyChat,
  findProposal,
  historyFor,
  isProposalExpired,
  removeEntry,
  setProposalStatus,
  type ChatState,
} from "@/lib/assistant/chat-state";
import type { Proposal } from "@/lib/assistant/types";

function proposal(id: string, overrides: Partial<Proposal> = {}): Proposal {
  return {
    id,
    action: "book",
    title: "Confirm booking",
    summary: "Book Dr. Mehta on Thursday at 10:30.",
    details: ["Dr. Mehta", "Thu, Nov 12 at 10:30"],
    token: `token-${id}`,
    expiresAt: Date.now() + 5 * 60_000,
    ...overrides,
  };
}

function withProposal(id = "p1", overrides: Partial<Proposal> = {}): ChatState {
  return addAssistantMessage(emptyChat(), "a1", "Check this card.", [proposal(id, overrides)]);
}

describe("chat state", () => {
  it("starts empty", () => {
    expect(emptyChat()).toEqual({ entries: [], proposals: [] });
  });

  it("trims a user message and refuses a blank one", () => {
    const once = addUserMessage(emptyChat(), "u1", "  book me in  ");
    expect(once.entries).toEqual([{ id: "u1", role: "user", content: "book me in" }]);

    const blank = addUserMessage(once, "u2", "   ");
    expect(blank).toBe(once);
  });

  it("adds the assistant reply and its proposal in one step", () => {
    const state = withProposal();

    expect(state.entries.map((entry) => entry.content)).toEqual(["Check this card."]);
    expect(state.proposals).toHaveLength(1);
    expect(state.proposals[0]?.status).toBe("pending");
  });

  it("does not track the same proposal twice", () => {
    const state = withProposal();
    const again = addAssistantMessage(state, "a2", "Still the same card.", [proposal("p1")]);

    expect(again.proposals).toHaveLength(1);
    expect(again.proposals[0]?.status).toBe("pending");
  });

  it("moves a proposal through working to confirmed and keeps the note", () => {
    const working = setProposalStatus(withProposal(), "p1", "working");
    const confirmed = setProposalStatus(working, "p1", "confirmed", "Booked for Thursday.");

    expect(confirmed.proposals[0]?.status).toBe("confirmed");
    expect(confirmed.proposals[0]?.note).toBe("Booked for Thursday.");
  });

  it("never rewrites a final status", () => {
    const confirmed = setProposalStatus(withProposal(), "p1", "confirmed", "Booked.");
    const lateFailure = setProposalStatus(confirmed, "p1", "failed", "Too late.");

    expect(lateFailure.proposals[0]?.status).toBe("confirmed");
    expect(lateFailure.proposals[0]?.note).toBe("Booked.");
  });

  it("leaves the state alone for an unknown proposal id", () => {
    const state = withProposal();
    expect(setProposalStatus(state, "nope", "confirmed")).toBe(state);
  });

  it("hides expired and spent cards from the actionable set", () => {
    const now = Date.now();
    let state = withProposal("live", { expiresAt: now + 60_000 });
    state = addAssistantMessage(state, "a2", "An old card.", [
      proposal("stale", { expiresAt: now - 1 }),
    ]);
    state = addAssistantMessage(state, "a3", "A spent card.", [
      proposal("spent", { expiresAt: now + 60_000 }),
    ]);
    state = setProposalStatus(state, "spent", "confirmed");

    const active = activeProposals(state, now);

    expect(active.map((tracked) => tracked.proposal.id)).toEqual(["live"]);
    expect(findProposal(state, "stale")?.status).toBe("pending");
    expect(isProposalExpired(findProposal(state, "stale")!.proposal, now)).toBe(true);
  });

  it("sends only the last six turns, in order, to the server", () => {
    let state = emptyChat();
    for (let index = 0; index < 14; index += 1) {
      state = addUserMessage(state, `u${index}`, `message ${index}`);
    }

    const history = historyFor(state);

    expect(history).toHaveLength(MAX_HISTORY);
    expect(history[0]).toEqual({ role: "user", content: "message 8" });
    expect(history.at(-1)).toEqual({ role: "user", content: "message 13" });
  });
});

describe("chat state retry", () => {
  it("removes a turn that never reached the assistant", () => {
    const state = addUserMessage(emptyChat(), "u1", "hello");

    expect(removeEntry(state, "u1").entries).toEqual([]);
  });

  it("leaves the rest of the conversation alone", () => {
    let state = withProposal();
    state = addUserMessage(state, "u2", "hello");

    const removed = removeEntry(state, "u2");

    expect(removed.entries.map((entry) => entry.content)).toEqual(["Check this card."]);
    expect(removed.proposals).toHaveLength(1);
  });

  it("returns the same state for an unknown turn", () => {
    const state = emptyChat();

    expect(removeEntry(state, "nope")).toBe(state);
  });
});

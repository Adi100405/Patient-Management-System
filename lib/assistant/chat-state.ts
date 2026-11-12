import type { Proposal } from "./types";

/**
 * The chat panel's state is a pure, serialisable value so it can be tested
 * without React: messages in order, plus the proposals that arrived with them.
 *
 * A proposal's status is local UI state; the signed token remains the only
 * authority. "working" exists so a double tap cannot start two confirms, and
 * final statuses are immutable so a late response cannot rewrite what the
 * person already saw.
 */

export type ChatEntry = {
  readonly id: string;
  readonly role: "user" | "assistant";
  readonly content: string;
};

export type ProposalStatus =
  | "pending"
  | "working"
  | "confirmed"
  | "declined"
  | "expired"
  | "failed";

export type TrackedProposal = {
  readonly proposal: Proposal;
  readonly status: ProposalStatus;
  /** The server's honest explanation after a failed confirm. */
  readonly note?: string;
};

export type ChatState = {
  readonly entries: readonly ChatEntry[];
  readonly proposals: readonly TrackedProposal[];
};

/** Six turns matches the cap the server enforces on the history it receives. */
export const MAX_HISTORY = 6;

const FINAL_STATUSES: ReadonlySet<ProposalStatus> = new Set([
  "confirmed",
  "declined",
  "expired",
  "failed",
]);

export function emptyChat(): ChatState {
  return { entries: [], proposals: [] };
}

export function addUserMessage(state: ChatState, id: string, content: string): ChatState {
  const text = content.trim();
  if (!text) return state;
  return { ...state, entries: [...state.entries, { id, role: "user", content: text }] };
}

export function addAssistantMessage(
  state: ChatState,
  id: string,
  content: string,
  proposals: readonly Proposal[] = [],
): ChatState {
  const text = content.trim();
  if (!text && proposals.length === 0) return state;

  const known = new Set(state.proposals.map((tracked) => tracked.proposal.id));
  const fresh = proposals
    .filter((proposal) => !known.has(proposal.id))
    .map((proposal): TrackedProposal => ({ proposal, status: "pending" }));

  return {
    entries: text ? [...state.entries, { id, role: "assistant", content: text }] : state.entries,
    proposals: fresh.length ? [...state.proposals, ...fresh] : state.proposals,
  };
}

export function setProposalStatus(
  state: ChatState,
  proposalId: string,
  status: ProposalStatus,
  note?: string,
): ChatState {
  let changed = false;

  const proposals = state.proposals.map((tracked) => {
    if (tracked.proposal.id !== proposalId) return tracked;
    // A final card never changes its mind; only an active one may progress.
    if (FINAL_STATUSES.has(tracked.status) && tracked.status !== status) return tracked;
    changed = true;
    return { ...tracked, status, ...(note === undefined ? {} : { note }) };
  });

  return changed ? { ...state, proposals } : state;
}

export function findProposal(state: ChatState, proposalId: string): TrackedProposal | null {
  return state.proposals.find((tracked) => tracked.proposal.id === proposalId) ?? null;
}

/**
 * Drops one turn. A failed send is rolled back with this: the message never
 * reached the assistant, so leaving it in the transcript would make the retry
 * look like a second question.
 */
export function removeEntry(state: ChatState, entryId: string): ChatState {
  const entries = state.entries.filter((entry) => entry.id !== entryId);
  return entries.length === state.entries.length ? state : { ...state, entries };
}

export function isProposalExpired(proposal: Proposal, now = Date.now()): boolean {
  return now > proposal.expiresAt;
}

/**
 * Cards still worth showing as actionable: not spent, not declined, and inside
 * the five-minute window. Expired-but-pending cards stay in the list so the UI
 * can explain why they cannot be tapped.
 */
export function activeProposals(state: ChatState, now = Date.now()): TrackedProposal[] {
  return state.proposals.filter(
    (tracked) =>
      (tracked.status === "pending" || tracked.status === "working") &&
      !isProposalExpired(tracked.proposal, now),
  );
}

/** The last ten turns in the shape `/api/assistant` accepts. */
export function historyFor(state: ChatState): Array<{ role: "user" | "assistant"; content: string }> {
  return state.entries
    .slice(-MAX_HISTORY)
    .map((entry) => ({ role: entry.role, content: entry.content }));
}

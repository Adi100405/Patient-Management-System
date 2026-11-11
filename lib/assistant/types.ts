/**
 * Shared vocabulary for the assistant.
 *
 * The assistant is deliberately split into a transport-agnostic core
 * (`lib/assistant/*`) and the HTTP routes that expose it, so the LLM call, the
 * prompt and the proposal signer can be unit-tested without a browser, a
 * session or a live model.
 */

export type AssistantRole = "patient" | "doctor";

/** The three write actions the assistant may propose. */
export type ProposalAction = "book" | "reschedule" | "cancel";

/** The languages the chat panel offers; the prompt translates the directive. */
export type ReplyLanguage = "en" | "hi" | "hinglish";

/**
 * Identity the tools run under. It is always taken from the signed session,
 * never from the request body, so a client cannot widen its own scope.
 */
export type AssistantContext = {
  readonly userId: number;
  readonly role: AssistantRole;
  readonly profileId: number;
  readonly name: string;
};

/** Plain `fetch` injection point, mirroring the notification transports. */
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/** One tool as the OpenAI-compatible chat API expects it. */
export type ToolDefinition = {
  readonly type: "function";
  readonly function: {
    readonly name: string;
    readonly description: string;
    readonly parameters: Record<string, unknown>;
  };
};

/** A tool call the model asked for. */
export type ToolCall = {
  readonly id: string;
  readonly type: "function";
  readonly function: { readonly name: string; readonly arguments: string };
};

export type ChatMessage = {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  tool_call_id?: string;
  tool_calls?: ToolCall[];
};

export type Completion = {
  readonly content: string | null;
  readonly toolCalls: ToolCall[];
};

/** One turn the browser sends back as history; the route re-validates it. */
export type ClientTurn = {
  readonly role: "user" | "assistant";
  readonly content: string;
};

/**
 * A write the assistant has prepared but not performed. The browser shows this
 * as a confirmation card; only the confirm endpoint can turn the signed token
 * into a real action.
 */
export type Proposal = {
  readonly id: string;
  readonly action: ProposalAction;
  readonly title: string;
  /** One speakable sentence describing exactly what Confirm will do. */
  readonly summary: string;
  /** Short display lines (doctor, date, fee); no free-text medical content. */
  readonly details: readonly string[];
  /** HMAC-signed, single-use, five-minute token. */
  readonly token: string;
  /** Epoch milliseconds; lets the UI grey the card out before the server says so. */
  readonly expiresAt: number;
};

/**
 * What a tool handler hands back: data for the model, and - for write tools -
 * the proposal the route forwards to the browser.
 */
export type ToolOutcome = {
  readonly result: unknown;
  readonly proposal?: Proposal;
};

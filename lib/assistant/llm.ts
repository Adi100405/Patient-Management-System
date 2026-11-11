import type { ChatMessage, Completion, FetchLike, ToolCall, ToolDefinition } from "./types";

/**
 * Groq chat-completions client.
 *
 * Groq speaks the OpenAI chat API, so this is one POST and no SDK - the same
 * choice the Resend transport makes, for the same reason: a single HTTP call
 * does not justify a dependency tree. `fetchImpl` is injectable so tests can
 * exercise request shaping and response parsing without a network or a key.
 */
const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";

/**
 * The default function-calling model. gpt-oss-120b calls tools on follow-up
 * turns where the smaller qwen model used to describe a confirmation card it
 * never created, and its tokenizer sends roughly a third fewer prompt tokens
 * for the same conversation - both matter under Groq's free-tier token budget.
 * A deployment may override it with ASSISTANT_MODEL.
 */
export const DEFAULT_ASSISTANT_MODEL = "openai/gpt-oss-120b";

export function assistantModel(): string {
  return process.env.ASSISTANT_MODEL?.trim() || DEFAULT_ASSISTANT_MODEL;
}

/**
 * A model failure the route can classify. `status` and `retryAfterSeconds` let
 * it tell "you are going too fast" apart from "the provider is down", instead
 * of collapsing both into one vague message.
 */
export class AssistantModelError extends Error {
  readonly status: number | null;
  readonly retryAfterSeconds: number | null;

  constructor(
    message: string,
    options: { status?: number | null; retryAfterSeconds?: number | null } = {},
  ) {
    super(message);
    this.name = "AssistantModelError";
    this.status = options.status ?? null;
    this.retryAfterSeconds = options.retryAfterSeconds ?? null;
  }
}

export type AssistantClient = {
  /** False when no API key reached the build; the route reports that honestly. */
  readonly configured: boolean;
  complete(
    messages: readonly ChatMessage[],
    tools: readonly ToolDefinition[],
  ): Promise<Completion>;
};

function retryAfterSeconds(response: Response): number | null {
  const raw = response.headers.get("retry-after");
  if (!raw) return null;
  const seconds = Number(raw);
  return Number.isFinite(seconds) && seconds > 0 ? Math.ceil(seconds) : null;
}

export function createAssistantClient(deps?: {
  fetchImpl?: FetchLike;
  apiKey?: string;
  model?: string;
}): AssistantClient {
  const apiKey = deps?.apiKey ?? process.env.GROQ_API_KEY?.trim() ?? null;
  const model = deps?.model ?? assistantModel();
  const doFetch = deps?.fetchImpl ?? fetch;

  return {
    configured: Boolean(apiKey),
    async complete(messages, tools) {
      if (!apiKey) {
        throw new AssistantModelError("The assistant is not configured on this deployment.");
      }

      let response: Response;
      try {
        response = await doFetch(GROQ_URL, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            model,
            messages,
            tools,
            tool_choice: "auto",
            // Low temperature: this is an operations assistant, not a writer.
            temperature: 0.2,
            // Replies are one to three sentences. A smaller cap leaves more of
            // the per-minute token budget for the tool loop.
            max_tokens: 400,
            // gpt-oss thinks before calling a tool; "low" keeps voice latency
            // and billed output tokens down without hurting tool choice.
            ...(model.includes("gpt-oss") ? { reasoning_effort: "low" } : {}),
          }),
          // Bounded so a hung model call cannot pin a serverless invocation open.
          signal: AbortSignal.timeout(20_000),
          cache: "no-store",
        });
      } catch (error) {
        throw new AssistantModelError(
          error instanceof Error ? error.message : "The model request failed.",
        );
      }

      const body = await response.text();
      if (!response.ok) {
        throw new AssistantModelError(
          `Groq rejected the request (${response.status}): ${body.slice(0, 300)}`,
          {
            status: response.status,
            retryAfterSeconds: retryAfterSeconds(response),
          },
        );
      }

      const payload = JSON.parse(body) as {
        choices?: Array<{
          message?: { content?: string | null; tool_calls?: ToolCall[] };
        }>;
      };
      const message = payload.choices?.[0]?.message;

      return {
        content: typeof message?.content === "string" ? message.content : null,
        toolCalls: Array.isArray(message?.tool_calls) ? message.tool_calls : [],
      };
    },
  };
}

import type { ChatMessage, Completion, FetchLike, ToolCall, ToolDefinition } from "./types";

/**
 * Groq chat-completions client.
 *
 * Groq speaks the OpenAI chat API, so this is one POST and no SDK — the same
 * choice the Resend transport makes, for the same reason: a single HTTP call
 * does not justify a dependency tree. `fetchImpl` is injectable so tests can
 * exercise request shaping and response parsing without a network or a key.
 */
const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";

/** The default function-calling model; a deployment may override it. */
export const DEFAULT_ASSISTANT_MODEL = "llama-3.3-70b-versatile";

export function assistantModel(): string {
  return process.env.ASSISTANT_MODEL?.trim() || DEFAULT_ASSISTANT_MODEL;
}

export type AssistantClient = {
  /** False when no API key reached the build; the route reports that honestly. */
  readonly configured: boolean;
  complete(
    messages: readonly ChatMessage[],
    tools: readonly ToolDefinition[],
  ): Promise<Completion>;
};

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
        throw new Error("The assistant is not configured on this deployment.");
      }

      const response = await doFetch(GROQ_URL, {
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
          max_tokens: 800,
        }),
        // Bounded so a hung model call cannot pin a serverless invocation open.
        signal: AbortSignal.timeout(20_000),
        cache: "no-store",
      });

      const body = await response.text();
      if (!response.ok) {
        throw new Error(
          `Groq rejected the request (${response.status}): ${body.slice(0, 200)}`,
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

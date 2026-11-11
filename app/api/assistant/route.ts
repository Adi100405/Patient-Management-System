import { NextResponse } from "next/server";
import { createAssistantClient } from "@/lib/assistant/llm";
import { buildSystemPrompt } from "@/lib/assistant/prompt";
import { executeAssistantTool, toolDefinitionsFor } from "@/lib/assistant/tools";
import type {
  ChatMessage,
  ClientTurn,
  Proposal,
  ReplyLanguage,
} from "@/lib/assistant/types";
import { getSession } from "@/lib/session";
import { clinicNow } from "@/lib/slots";

/**
 * The assistant's chat endpoint.
 *
 * One POST: session check, rate limit, sanitize the browser history, then run
 * the Groq function-calling loop. Tool execution happens server-side under the
 * signed session's identity; the browser only ever receives the final reply and
 * the confirmation cards (never a raw tool result).
 */
export const dynamic = "force-dynamic";

/** Four passes is enough for read → propose → confirm-preparation flows. */
const MAX_TOOL_ITERATIONS = 4;
/** Ten turns of context, matching the panel's own cap. */
const MAX_HISTORY_MESSAGES = 10;
const MAX_MESSAGE_LENGTH = 1500;
const RATE_LIMIT_MESSAGES = 20;
const RATE_LIMIT_WINDOW_MS = 60_000;

/**
 * Per-user, per-instance rate limit. Serverless instances each keep their own
 * map; that is acceptable for a conversational endpoint whose cost is bounded
 * by the caps above, and it never blocks a legitimate burst of 20 messages.
 */
const requestLog = new Map<number, number[]>();

function withinRateLimit(userId: number): boolean {
  const now = Date.now();
  const recent = (requestLog.get(userId) ?? []).filter(
    (at) => now - at < RATE_LIMIT_WINDOW_MS,
  );
  if (recent.length >= RATE_LIMIT_MESSAGES) {
    requestLog.set(userId, recent);
    return false;
  }
  recent.push(now);
  requestLog.set(userId, recent);
  return true;
}

function sanitizeHistory(value: unknown): ClientTurn[] {
  if (!Array.isArray(value)) return [];
  const turns: ClientTurn[] = [];
  for (const item of value.slice(-MAX_HISTORY_MESSAGES)) {
    if (!item || typeof item !== "object") continue;
    const role = (item as { role?: unknown }).role;
    const content = (item as { content?: unknown }).content;
    if ((role === "user" || role === "assistant") && typeof content === "string" && content.trim()) {
      turns.push({ role, content: content.trim().slice(0, 1200) });
    }
  }
  return turns;
}

function parseLanguage(value: unknown): ReplyLanguage {
  return value === "hi" || value === "hinglish" ? value : "en";
}

type AssistantRequest = {
  message?: unknown;
  history?: unknown;
  language?: unknown;
};

export async function POST(request: Request) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  if (!withinRateLimit(session.userId)) {
    return NextResponse.json(
      { error: "That is a lot of messages at once. Give it a moment, then continue." },
      { status: 429 },
    );
  }

  const body = (await request.json().catch(() => null)) as AssistantRequest | null;
  const message = typeof body?.message === "string" ? body.message.trim() : "";
  if (!message || message.length > MAX_MESSAGE_LENGTH) {
    return NextResponse.json(
      { error: `Send a message between 1 and ${MAX_MESSAGE_LENGTH} characters.` },
      { status: 400 },
    );
  }

  const client = createAssistantClient();
  if (!client.configured) {
    return NextResponse.json(
      {
        error:
          "The assistant is not configured on this deployment yet. Add GROQ_API_KEY to the environment and redeploy.",
      },
      { status: 503 },
    );
  }

  const language = parseLanguage(body?.language);
  const history = sanitizeHistory(body?.history);
  const tools = toolDefinitionsFor(session.role);

  const messages: ChatMessage[] = [
    {
      role: "system",
      content: buildSystemPrompt({
        role: session.role,
        name: session.name,
        language,
        today: clinicNow().date,
      }),
    },
    ...history.map((turn): ChatMessage => ({ role: turn.role, content: turn.content })),
    { role: "user", content: message },
  ];

  const proposals: Proposal[] = [];
  let reply = "";

  try {
    for (let iteration = 0; iteration < MAX_TOOL_ITERATIONS; iteration += 1) {
      const completion = await client.complete(messages, tools);

      if (completion.toolCalls.length === 0) {
        reply = (completion.content ?? "").trim();
        break;
      }

      messages.push({
        role: "assistant",
        content: completion.content ?? "",
        tool_calls: completion.toolCalls,
      });

      for (const call of completion.toolCalls) {
        const outcome = await executeAssistantTool(
          call.function.name,
          call.function.arguments ?? "",
          {
            userId: session.userId,
            role: session.role,
            profileId: session.profileId,
            name: session.name,
          },
        );
        if (outcome.proposal) proposals.push(outcome.proposal);
        messages.push({
          role: "tool",
          tool_call_id: call.id,
          // Bounded: a long list must not blow the model's context or the
          // ledger row. The UI gets the structured proposal, not this text.
          content: JSON.stringify(outcome.result).slice(0, 4000),
        });
      }
    }
  } catch (error) {
    console.error(
      "[assistant] completion failed:",
      error instanceof Error ? error.message : error,
    );
    return NextResponse.json(
      { error: "The assistant is unavailable right now. Please try again in a moment." },
      { status: 502 },
    );
  }

  if (!reply) {
    reply = proposals.length
      ? "I have prepared that. Please check the confirmation card and tap Confirm if it looks right."
      : "I could not finish that request. Could you rephrase it?";
  }

  return NextResponse.json({ reply, proposals });
}

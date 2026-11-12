import { NextResponse } from "next/server";
import { AssistantModelError, createAssistantClient } from "@/lib/assistant/llm";
import {
  classifyFallbackIntent,
  formatFallbackReply,
  planFor,
} from "@/lib/assistant/fallback";
import {
  buildSystemPrompt,
  replyClaimsCard,
  replyClaimsCompletedWrite,
} from "@/lib/assistant/prompt";
import { executeAssistantTool, toolDefinitionsFor } from "@/lib/assistant/tools";
import type {
  AssistantContext,
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
 *
 * Two rules shape the failure path. A reply may only describe a confirmation
 * card the server actually minted, and a write may only be described as done
 * after the person taps Confirm. When the model is unavailable the endpoint
 * still answers the dashboard-level reads from the database and says plainly
 * that the assistant was busy.
 */
export const dynamic = "force-dynamic";

/** Four passes is enough for read → propose → confirm-preparation flows. */
const MAX_TOOL_ITERATIONS = 4;
/**
 * Six turns of context. The model's free tier counts every prompt token, and a
 * long transcript is the fastest way to run out of them mid-demo.
 */
const MAX_HISTORY_MESSAGES = 6;
const MAX_HISTORY_CONTENT = 800;
const MAX_MESSAGE_LENGTH = 1500;
/** A tool result is data for the model, not the whole database. */
const MAX_TOOL_RESULT_CHARS = 1800;
const RATE_LIMIT_MESSAGES = 20;
const RATE_LIMIT_WINDOW_MS = 60_000;
/** What the browser should wait before trying the model again. */
const DEFAULT_RETRY_AFTER_SECONDS = 20;

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
      turns.push({ role, content: content.trim().slice(0, MAX_HISTORY_CONTENT) });
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

/**
 * The few sentences the server writes without the model. They follow the chosen
 * reply language so a Hindi or Hinglish turn never falls back to English just
 * because the model ran out of passes or claimed something it had not done.
 */
const STATIC_REPLIES = {
  preparedNoWrite: {
    en: "I have prepared that, but nothing changes until you tap Confirm on the card.",
    hi: "मैंने वह तैयार कर दिया है, लेकिन कार्ड पर Confirm दबाने तक कुछ नहीं बदलेगा।",
    hinglish: "Maine woh taiyaar kar diya hai, lekin card par Confirm dabane tak kuch nahi badlega.",
  },
  nothingChanged: {
    en: "Nothing has been changed yet. Please try again, or use the dashboard to make the change.",
    hi: "अभी कुछ नहीं बदला है। कृपया फिर कोशिश करें या बदलाव डैशबोर्ड से करें।",
    hinglish: "Abhi kuch nahi badla. Dobara try kijiye ya dashboard se badlav kar lijiye.",
  },
  couldNotPrepare: {
    en: "I could not prepare that confirmation. Please try again in a moment.",
    hi: "मैं वह पुष्टि कार्ड तैयार नहीं कर सका। कृपया थोड़ी देर में फिर कोशिश करें।",
    hinglish: "Main woh confirmation card taiyaar nahi kar saka. Thodi der baad dobara try kijiye.",
  },
  prepared: {
    en: "I have prepared that. Please check the confirmation card and tap Confirm if it looks right.",
    hi: "मैंने वह तैयार कर दिया है। कृपया confirmation card देखें और सही लगे तो Confirm दबाएँ।",
    hinglish: "Maine woh taiyaar kar diya hai. Confirmation card dekh kar sahi lage to Confirm dabaayein.",
  },
  couldNotFinish: {
    en: "I could not finish that request. Could you rephrase it?",
    hi: "मैं वह अनुरोध पूरा नहीं कर सका। क्या आप दोबारा बता सकते हैं?",
    hinglish: "Main woh request poora nahi kar saka. Kya aap dobara bata sakte hain?",
  },
} as const;

function staticReply(language: ReplyLanguage, key: keyof typeof STATIC_REPLIES): string {
  return STATIC_REPLIES[key][language];
}

/**
 * The quick answer: the one dashboard-level read a message needs, answered
 * straight from the database while the model is unavailable. It never writes,
 * and it returns null when the message needs more than a read.
 */
async function quickAnswer(
  ctx: AssistantContext,
  message: string,
  language: ReplyLanguage,
): Promise<string | null> {
  const intent = classifyFallbackIntent(ctx.role, message);
  if (!intent) return null;

  const plan = planFor(intent);
  const outcome = await executeAssistantTool(
    plan.tool,
    JSON.stringify(plan.args),
    ctx,
  );
  return formatFallbackReply(plan, outcome.result, language);
}

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

  const language = parseLanguage(body?.language);
  const history = sanitizeHistory(body?.history);
  const ctx: AssistantContext = {
    userId: session.userId,
    role: session.role,
    profileId: session.profileId,
    name: session.name,
  };

  const client = createAssistantClient();
  if (!client.configured) {
    const quick = await quickAnswer(ctx, message, language);
    if (quick) {
      return NextResponse.json({ reply: quick, proposals: [], busy: true });
    }
    return NextResponse.json(
      {
        error:
          "The assistant is not configured on this deployment yet. Add GROQ_API_KEY to the environment and redeploy.",
      },
      { status: 503 },
    );
  }

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
          ctx,
        );
        if (outcome.proposal) proposals.push(outcome.proposal);
        messages.push({
          role: "tool",
          tool_call_id: call.id,
          // Bounded: a long list must not blow the model's context or the
          // ledger row. The UI gets the structured proposal, not this text.
          content: JSON.stringify(outcome.result).slice(0, MAX_TOOL_RESULT_CHARS),
        });
      }
    }
  } catch (error) {
    const busy = error instanceof AssistantModelError && error.status === 429;
    const retryAfterSeconds = busy
      ? (error.retryAfterSeconds ?? DEFAULT_RETRY_AFTER_SECONDS)
      : null;

    const quick = await quickAnswer(ctx, message, language);
    if (quick) {
      return NextResponse.json({
        reply: quick,
        proposals: [],
        busy: true,
        retryAfterSeconds,
      });
    }

    if (retryAfterSeconds !== null) {
      return NextResponse.json(
        {
          error: `The assistant is busy right now. Try again in about ${retryAfterSeconds} seconds.`,
          retryAfterSeconds,
        },
        { status: 429, headers: { "Retry-After": String(retryAfterSeconds) } },
      );
    }

    console.error(
      "[assistant] completion failed:",
      error instanceof Error ? error.message : error,
    );
    return NextResponse.json(
      { error: "The assistant is unavailable right now. Please try again in a moment." },
      { status: 502 },
    );
  }

  if (replyClaimsCompletedWrite(reply)) {
    reply = proposals.length
      ? staticReply(language, "preparedNoWrite")
      : staticReply(language, "nothingChanged");
  }
  if (replyClaimsCard(reply) && proposals.length === 0) {
    reply = staticReply(language, "couldNotPrepare");
  }

  if (!reply) {
    reply = proposals.length
      ? staticReply(language, "prepared")
      : staticReply(language, "couldNotFinish");
  }

  return NextResponse.json({ reply, proposals });
}

"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Send, Plus, Sparkles, Volume2, VolumeX, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import {
  addAssistantMessage,
  addUserMessage,
  chatHistoryKey,
  emptyChat,
  findProposal,
  historyFor,
  isProposalExpired,
  removeEntry,
  restoreChat,
  setProposalStatus,
  storeChat,
  type ChatState,
} from "@/lib/assistant/chat-state";
import { isReplyLanguage, LANGUAGE_STORAGE_KEY, readStoredLanguage } from "@/lib/assistant/lang";
import type { Proposal, ReplyLanguage } from "@/lib/assistant/types";
import { cn } from "@/lib/utils";
import { ConfirmationCard } from "./confirmation-card";
import { LanguagePicker } from "./language-picker";
import { PaymentCard } from "./payment-card";
import { useSpeech } from "./use-speech";
import { useVoice } from "./use-voice";
import { VoiceButton } from "./voice-button";

type ChatResponse = {
  reply?: unknown;
  proposals?: unknown;
  error?: unknown;
};

type ConfirmResponse = {
  ok?: unknown;
  message?: unknown;
  appointmentId?: unknown;
  payment?: { amount?: unknown; currency?: unknown; online?: unknown } | null;
  error?: unknown;
};

type PaymentCardState = {
  appointmentId: number;
  amount: string;
  currency: string;
};

const SUGGESTIONS = {
  patient: [
    "What appointments do I have?",
    "Find a dermatologist",
    "Book my next visit",
  ],
  doctor: ["How is today going?", "Any schedule conflicts?", "When is my next free slot?"],
} as const;

function newId(prefix: string): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return `${prefix}-${crypto.randomUUID()}`;
  }
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Browser storage can be disabled (private mode) or full. History is a
 * convenience, never a requirement, so those two failures degrade to an
 * in-memory conversation instead of breaking the panel.
 */
function readStoredChat(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch (error) {
    if (error instanceof DOMException) return null;
    throw error;
  }
}

function writeStoredChat(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch (error) {
    if (error instanceof DOMException) return;
    throw error;
  }
}

/** The network is untrusted: only a well-shaped proposal reaches the card. */
function isProposal(value: unknown): value is Proposal {
  if (!value || typeof value !== "object") return false;
  const proposal = value as Partial<Proposal>;
  return (
    typeof proposal.id === "string" &&
    (proposal.action === "book" ||
      proposal.action === "reschedule" ||
      proposal.action === "cancel") &&
    typeof proposal.title === "string" &&
    typeof proposal.summary === "string" &&
    Array.isArray(proposal.details) &&
    proposal.details.every((detail) => typeof detail === "string") &&
    typeof proposal.token === "string" &&
    typeof proposal.expiresAt === "number"
  );
}

/**
 * The conversation itself: messages, signed proposal cards, voice input and
 * spoken replies. It is mounted only while the panel is open, so opening it
 * starts no microphone and closing it cancels both recognition and speech.
 */
export function ChatPanel({
  role,
  name,
  userId,
  onClose,
}: {
  role: "patient" | "doctor";
  name: string;
  userId: number;
  onClose: () => void;
}) {
  const router = useRouter();
  const inputId = useId();
  const historyKey = chatHistoryKey(role, userId);

  const [state, setState] = useState<ChatState>(() =>
    typeof window === "undefined" ? emptyChat() : restoreChat(readStoredChat(historyKey)),
  );
  const [input, setInput] = useState("");
  // The panel only mounts on the client, so the saved choice can be read once
  // during the first render instead of flashing English first.
  const [language, setLanguage] = useState<ReplyLanguage>(() =>
    readStoredLanguage(typeof window === "undefined" ? null : window.localStorage),
  );
  const [voiceReplies, setVoiceReplies] = useState(false);
  const [voiceError, setVoiceError] = useState<string | null>(null);
  const [interim, setInterim] = useState("");
  const [sending, setSending] = useState(false);
  const [payments, setPayments] = useState<PaymentCardState[]>([]);

  const stateRef = useRef(state);
  const sendingRef = useRef(false);
  const languageRef = useRef(language);
  const voiceRepliesRef = useRef(voiceReplies);
  const bottomRef = useRef<HTMLDivElement>(null);
  const sendRef = useRef<(text: string) => void>(() => {});

  useEffect(() => {
    stateRef.current = state;
  }, [state]);

  // The transcript survives closing the panel and reloading this browser. A
  // new message rewrites the copy; cards are deliberately never stored.
  useEffect(() => {
    writeStoredChat(historyKey, storeChat(state));
  }, [historyKey, state]);
  useEffect(() => {
    languageRef.current = language;
  }, [language]);
  useEffect(() => {
    voiceRepliesRef.current = voiceReplies;
  }, [voiceReplies]);

  const speech = useSpeech(language);
  const speechRef = useRef(speech);
  useEffect(() => {
    speechRef.current = speech;
  }, [speech]);

  const sendMessage = useCallback(async (raw: string) => {
    const text = raw.trim();
    if (!text || sendingRef.current) return;

    sendingRef.current = true;
    setSending(true);
    setInput("");
    setInterim("");
    setVoiceError(null);
    speechRef.current.cancel();

    // History is the conversation before this message; the route appends the
    // message itself, exactly like it would for a typed turn.
    const snapshot = stateRef.current;
    const userId = newId("user");
    setState((current) => addUserMessage(current, userId, text));

    try {
      const response = await fetch("/api/assistant", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: text,
          history: historyFor(snapshot),
          language: languageRef.current,
        }),
      });
      const data = (await response.json().catch(() => null)) as ChatResponse | null;

      if (!response.ok) {
        const message =
          typeof data?.error === "string"
            ? data.error
            : "The assistant is unavailable right now. Please try again.";
        // The turn never happened, so it is rolled back out of the transcript
        // and the text goes back into the box: a retry is one tap, not a retype.
        setState((current) =>
          addAssistantMessage(removeEntry(current, userId), newId("assistant"), message),
        );
        setInput(text);
        return;
      }

      const reply = typeof data?.reply === "string" ? data.reply.trim() : "";
      const proposals = Array.isArray(data?.proposals)
        ? data.proposals.filter(isProposal)
        : [];

      setState((current) =>
        addAssistantMessage(current, newId("assistant"), reply, proposals),
      );
      if (reply && voiceRepliesRef.current) speechRef.current.speak(reply);
    } catch {
      setState((current) =>
        addAssistantMessage(
          removeEntry(current, userId),
          newId("assistant"),
          "I could not reach the assistant. Check your connection and try again.",
        ),
      );
      setInput(text);
    } finally {
      sendingRef.current = false;
      setSending(false);
    }
  }, []);

  useEffect(() => {
    sendRef.current = sendMessage;
  }, [sendMessage]);

  const voice = useVoice({
    language,
    echoTextRef: speech.spokenTextRef,
    speakingRef: speech.speakingRef,
    onFinal: (text) => {
      setVoiceReplies(true);
      setInterim("");
      sendRef.current(text);
    },
    onInterim: (text) => setInterim(text),
    onBargeIn: () => speechRef.current.cancel(),
    onError: (message) => setVoiceError(message),
  });

  const voiceRef = useRef(voice);
  useEffect(() => {
    voiceRef.current = voice;
  }, [voice]);

  // Closing the panel must silence it, even if the user never pressed stop.
  useEffect(() => {
    return () => {
      voiceRef.current.stop();
      speechRef.current.cancel();
    };
  }, []);

  useEffect(() => {
    try {
      window.localStorage.setItem(LANGUAGE_STORAGE_KEY, language);
    } catch {
      // Private browsing may refuse storage; the session still works.
    }
    speech.cancel();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- cancel is stable
  }, [language]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: "end" });
  }, [state.entries.length, state.proposals.length, payments.length, sending]);

  const confirmProposal = useCallback(
    async (proposalId: string) => {
      const tracked = findProposal(stateRef.current, proposalId);
      if (!tracked || tracked.status !== "pending") return;

      if (isProposalExpired(tracked.proposal)) {
        setState((current) => setProposalStatus(current, proposalId, "expired"));
        return;
      }

      setState((current) => setProposalStatus(current, proposalId, "working"));

      try {
        const response = await fetch("/api/assistant/confirm", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ token: tracked.proposal.token }),
        });
        const data = (await response.json().catch(() => null)) as ConfirmResponse | null;

        if (!response.ok) {
          const message =
            typeof data?.error === "string"
              ? data.error
              : "That change could not be completed. Ask me to check again.";
          const status = response.status === 409 || response.status === 410 ? "expired" : "failed";
          setState((current) => {
            const withStatus = setProposalStatus(current, proposalId, status, message);
            return addAssistantMessage(withStatus, newId("assistant"), message);
          });
          return;
        }

        const message =
          typeof data?.message === "string" && data.message.trim()
            ? data.message
            : "Done. The change is written.";
        setState((current) => {
          const withStatus = setProposalStatus(current, proposalId, "confirmed", message);
          return addAssistantMessage(withStatus, newId("assistant"), message);
        });

        const appointmentId = data?.appointmentId;
        const payment = data?.payment;
        if (
          payment &&
          payment.online === true &&
          typeof appointmentId === "number" &&
          typeof payment.amount === "string" &&
          typeof payment.currency === "string"
        ) {
          setPayments((current) =>
            current.some((card) => card.appointmentId === appointmentId)
              ? current
              : [
                  ...current,
                  {
                    appointmentId,
                    amount: payment.amount as string,
                    currency: payment.currency as string,
                  },
                ],
          );
        }

        if (voiceRepliesRef.current) speechRef.current.speak(message);
        // The real actions revalidate their paths; refreshing keeps the
        // dashboard behind the panel in step without a reload.
        router.refresh();
      } catch {
        const message =
          "I could not confirm that change. Nothing was written as far as I know — ask me to check again.";
        setState((current) => {
          const withStatus = setProposalStatus(current, proposalId, "failed", message);
          return addAssistantMessage(withStatus, newId("assistant"), message);
        });
      }
    },
    [router],
  );

  const declineProposal = useCallback((proposalId: string) => {
    setState((current) => setProposalStatus(current, proposalId, "declined"));
  }, []);

  const toggleReplies = () => {
    const next = !voiceReplies;
    setVoiceReplies(next);
    if (!next) speech.cancel();
  };

  const toggleListening = () => {
    if (voice.listening) {
      voice.stop();
      setInterim("");
      return;
    }
    setVoiceError(null);
    setVoiceReplies(true);
    voice.start();
  };

  const startNewChat = () => {
    voice.stop();
    speech.cancel();
    setState(emptyChat());
    setPayments([]);
    setInput("");
    setInterim("");
    setVoiceError(null);
  };

  const firstName = name.replace(/^Dr\.?\s+/i, "").split(/\s+/)[0] || name;
  const suggestions = SUGGESTIONS[role];

  return (
    <div className="flex h-full min-h-0 flex-col bg-cream-50">
      <header className="flex items-center justify-between gap-2 border-b border-cream-200 bg-white/95 px-3.5 py-3">
        <div className="flex min-w-0 items-center gap-2.5">
          <span
            aria-hidden="true"
            className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-teal-50 text-teal-700 ring-1 ring-inset ring-teal-100"
          >
            <Sparkles className="h-4 w-4" />
          </span>
          <div className="min-w-0">
            <p className="truncate text-sm font-semibold text-ink-900">Medrella Assistant</p>
            <p className="truncate text-[11px] text-ink-500">
              {role === "doctor" ? "Your schedule, in a sentence" : "Your visits, in a sentence"}
            </p>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <Button
            type="button"
            variant="ghost"
            size="icon"
            onClick={startNewChat}
            disabled={state.entries.length === 0 && state.proposals.length === 0}
            aria-label="Start a new chat"
            title="Start a new chat"
          >
            <Plus className="h-4 w-4" />
          </Button>
          <LanguagePicker
            value={language}
            onChange={(next) => {
              if (isReplyLanguage(next)) setLanguage(next);
            }}
          />
          <Button
            type="button"
            variant="ghost"
            size="icon"
            onClick={toggleReplies}
            disabled={!speech.supported}
            aria-pressed={voiceReplies}
            aria-label={voiceReplies ? "Turn spoken replies off" : "Turn spoken replies on"}
            title={
              speech.supported
                ? voiceReplies
                  ? "Spoken replies are on"
                  : "Speak replies aloud"
                : "This browser cannot speak replies"
            }
          >
            {voiceReplies ? <Volume2 className="h-4 w-4" /> : <VolumeX className="h-4 w-4" />}
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            onClick={onClose}
            aria-label="Close assistant"
          >
            <X className="h-4 w-4" />
          </Button>
        </div>
      </header>

      <div
        role="log"
        aria-live="polite"
        aria-relevant="additions"
        className="min-h-0 flex-1 space-y-3 overflow-y-auto px-3.5 py-4"
      >
        {state.entries.length === 0 && state.proposals.length === 0 && (
          <div className="space-y-4 py-3">
            <div className="mx-auto grid h-12 w-12 place-items-center rounded-full bg-teal-50 text-teal-700 ring-1 ring-inset ring-teal-100">
              <Sparkles className="h-5 w-5" aria-hidden="true" />
            </div>
            <div className="text-center">
              <p className="text-sm font-semibold text-ink-900">Hi {firstName}</p>
              <p className="mx-auto mt-1 max-w-[30ch] text-xs leading-relaxed text-ink-500">
                {role === "doctor"
                  ? "Ask about today's visits, your windows, or where a patient could move."
                  : "Ask about your visits, find a doctor, or book, move and cancel — only after you confirm."}
              </p>
            </div>
            <div className="space-y-2">
              {suggestions.map((suggestion) => (
                <button
                  key={suggestion}
                  type="button"
                  onClick={() => void sendMessage(suggestion)}
                  className="w-full rounded-xl border border-cream-200 bg-white px-3 py-2.5 text-left text-xs text-ink-700 transition hover:border-teal-300 hover:bg-teal-50/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal-600"
                >
                  {suggestion}
                </button>
              ))}
            </div>
          </div>
        )}

        {state.entries.map((entry) => (
          <div
            key={entry.id}
            className={cn("flex", entry.role === "user" ? "justify-end" : "justify-start")}
          >
            <div
              className={cn(
                "max-w-[85%] whitespace-pre-wrap rounded-2xl px-3.5 py-2.5 text-sm leading-relaxed",
                entry.role === "user"
                  ? "rounded-br-md bg-teal-700 text-white"
                  : "rounded-bl-md border border-cream-200 bg-white text-ink-800",
              )}
            >
              {entry.content}
            </div>
          </div>
        ))}

        {state.proposals.map((tracked) => (
          <ConfirmationCard
            key={tracked.proposal.id}
            tracked={tracked}
            onConfirm={(proposalId) => void confirmProposal(proposalId)}
            onDecline={declineProposal}
          />
        ))}

        {payments.map((card) => (
          <PaymentCard
            key={card.appointmentId}
            appointmentId={card.appointmentId}
            amount={card.amount}
            currency={card.currency}
          />
        ))}

        {sending && (
          <div className="flex justify-start">
            <div className="inline-flex items-center gap-1.5 rounded-2xl rounded-bl-md border border-cream-200 bg-white px-3.5 py-3">
              <span className="sr-only">The assistant is thinking</span>
              {[0, 150, 300].map((delay) => (
                <span
                  key={delay}
                  aria-hidden="true"
                  className="h-1.5 w-1.5 rounded-full bg-ink-300 motion-safe:animate-bounce"
                  style={{ animationDelay: `${delay}ms` }}
                />
              ))}
            </div>
          </div>
        )}

        <div ref={bottomRef} />
      </div>

      <form
        onSubmit={(event) => {
          event.preventDefault();
          void sendMessage(input);
        }}
        className="border-t border-cream-200 bg-white p-3"
      >
        {interim && (
          <p className="mb-1.5 line-clamp-2 px-0.5 text-xs italic text-ink-500" aria-live="polite">
            {interim}
          </p>
        )}
        {voiceError && (
          <p role="alert" className="mb-1.5 rounded-lg bg-rose-50 px-2 py-1.5 text-[11px] text-rose-700">
            {voiceError}
          </p>
        )}
        <div className="flex items-end gap-2">
          <label htmlFor={inputId} className="sr-only">
            Message the assistant
          </label>
          <textarea
            id={inputId}
            rows={1}
            value={input}
            onChange={(event) => setInput(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                void sendMessage(input);
              }
            }}
            placeholder={
              role === "doctor"
                ? "Ask about your day, windows or conflicts"
                : "Ask about visits, doctors or booking"
            }
            className="max-h-28 min-h-10 flex-1 resize-none rounded-xl border border-cream-300 bg-white px-3 py-2.5 text-sm text-ink-900 placeholder:text-ink-500/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal-600 disabled:opacity-60"
            disabled={sending}
          />
          <VoiceButton
            supported={voice.supported}
            listening={voice.listening}
            onClick={toggleListening}
          />
          <Button
            type="submit"
            size="icon"
            className="h-10 w-10 shrink-0"
            disabled={!input.trim() || sending}
            aria-label="Send message"
          >
            {sending ? <Spinner className="h-4 w-4" /> : <Send className="h-4 w-4" />}
          </Button>
        </div>
        <p className="mt-1.5 px-0.5 text-[10px] leading-relaxed text-ink-500">
          AI can be wrong. Confirm a card before I change anything.
        </p>
      </form>
    </div>
  );
}

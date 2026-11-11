"use client";

import { Mic, MicOff } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * Microphone toggle. While listening, the ring pulses so the person can see
 * that the browser is still capturing; the label spells out the action for
 * screen readers.
 */
export function VoiceButton({
  supported,
  listening,
  onClick,
}: {
  supported: boolean;
  listening: boolean;
  onClick: () => void;
}) {
  if (!supported) {
    return (
      <button
        type="button"
        disabled
        title="Voice input is not supported in this browser"
        aria-label="Voice input is not supported in this browser"
        className="grid h-10 w-10 shrink-0 place-items-center rounded-xl border border-cream-200 bg-cream-100 text-ink-500"
      >
        <MicOff className="h-4 w-4" aria-hidden="true" />
      </button>
    );
  }

  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={listening}
      aria-label={listening ? "Stop listening" : "Start voice input"}
      title={listening ? "Stop listening" : "Speak instead of typing"}
      className={cn(
        "relative grid h-10 w-10 shrink-0 place-items-center rounded-xl border transition duration-150 active:scale-[0.98] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal-600 focus-visible:ring-offset-2",
        listening
          ? "border-rose-500 bg-rose-600 text-white shadow-sm"
          : "border-cream-300 bg-white text-ink-700 hover:bg-cream-100",
      )}
    >
      {listening && (
        <span
          aria-hidden="true"
          className="absolute inset-0 rounded-xl bg-rose-400/40 motion-safe:animate-pulse"
        />
      )}
      <Mic className="relative h-4 w-4" aria-hidden="true" />
    </button>
  );
}

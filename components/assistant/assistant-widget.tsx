"use client";

import { useEffect, useRef, useState } from "react";
import { Sparkles, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { ChatPanel } from "./chat-panel";

/**
 * The assistant's home on both dashboards.
 *
 * Desktop gets a side panel that leaves the page visible; a phone gets a
 * bottom sheet over a dimmed backdrop. The launcher stays on screen either way
 * so the same tap closes what it opened.
 */
export function AssistantWidget({
  role,
  name,
  userId,
}: {
  role: "patient" | "doctor";
  name: string;
  userId: number;
}) {
  const [open, setOpen] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const panel = panelRef.current;
    const previouslyFocused = document.activeElement as HTMLElement | null;
    panel?.focus();

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        setOpen(false);
        return;
      }
      if (event.key !== "Tab" || !panel) return;
      const focusable = panel.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), textarea, input, select, [tabindex]:not([tabindex="-1"])',
      );
      if (focusable.length === 0) return;
      const first = focusable[0]!;
      const last = focusable[focusable.length - 1]!;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      previouslyFocused?.focus?.();
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previous;
    };
  }, [open]);

  return (
    <>
      {open && (
        <div
          aria-hidden="true"
          onClick={() => setOpen(false)}
          className="fixed inset-0 z-40 bg-ink-900/25 backdrop-blur-[2px] sm:hidden"
        />
      )}

      {open && (
        <div
          id="medrella-assistant"
          ref={panelRef}
          tabIndex={-1}
          role="dialog"
          aria-modal="true"
          aria-label="Medrella assistant"
          className="fixed inset-x-0 bottom-0 z-50 h-[86vh] overflow-hidden rounded-t-3xl border border-cream-200 bg-cream-50 shadow-[0_-12px_50px_-12px_rgba(33,29,24,0.35)] outline-none sm:inset-x-auto sm:bottom-24 sm:right-5 sm:h-[min(640px,calc(100vh-8rem))] sm:w-[400px] sm:rounded-3xl sm:shadow-[0_24px_60px_-20px_rgba(33,29,24,0.35)]"
        >
          <ChatPanel
            role={role}
            name={name}
            userId={userId}
            onClose={() => setOpen(false)}
          />
        </div>
      )}

      <button
        type="button"
        onClick={() => setOpen((current) => !current)}
        aria-expanded={open}
        aria-controls="medrella-assistant"
        aria-label={open ? "Close Medrella assistant" : "Open Medrella assistant"}
        className={cn(
          "fixed bottom-5 right-5 z-40 inline-flex items-center gap-2 rounded-full bg-teal-700 px-4 py-3 text-sm font-medium text-white shadow-lg transition duration-200 hover:bg-teal-800 active:scale-[0.98] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal-600 focus-visible:ring-offset-2 focus-visible:ring-offset-cream-50",
          open && "sm:opacity-0 sm:pointer-events-none",
        )}
      >
        {open ? (
          <X className="h-4 w-4" aria-hidden="true" />
        ) : (
          <Sparkles className="h-4 w-4" aria-hidden="true" />
        )}
        <span>{open ? "Close" : "Ask Medrella"}</span>
      </button>
    </>
  );
}

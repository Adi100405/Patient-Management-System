"use client";

import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * A small, dependency-free confirm dialog (DESIGN.md §5).
 *
 * - Fades/scales in on open, fades out on close (transform + opacity only).
 * - `role="dialog"` + `aria-modal`, labelled by the title.
 * - Esc and backdrop click close it; Tab is trapped inside; focus returns to
 *   the element that opened it.
 * - Body scroll is locked while it is open.
 * - Under `prefers-reduced-motion` the animations collapse to ~0ms and it
 *   simply appears — still fully usable.
 */
export function Dialog({
  open,
  onClose,
  title,
  description,
  children,
  closeOnBackdrop = true,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: ReactNode;
  children: ReactNode;
  closeOnBackdrop?: boolean;
}) {
  const titleId = useId();
  const descriptionId = useId();
  const panelRef = useRef<HTMLDivElement>(null);
  const [mounted, setMounted] = useState(open);

  // Keep the node mounted for the length of the exit fade, then drop it.
  useEffect(() => {
    if (open) {
      setMounted(true);
      return;
    }
    const timer = setTimeout(() => setMounted(false), 150);
    return () => clearTimeout(timer);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const panel = panelRef.current;
    const previouslyFocused = document.activeElement as HTMLElement | null;
    panel?.focus();

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
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
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.body.style.overflow = previousOverflow;
      previouslyFocused?.focus?.();
    };
  }, [open, onClose]);

  if (!mounted) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center p-4 sm:items-center">
      <div
        aria-hidden="true"
        onClick={closeOnBackdrop ? onClose : undefined}
        className={cn(
          "fixed inset-0 bg-ink-900/45 backdrop-blur-[2px]",
          open ? "animate-overlay-in" : "opacity-0 transition-opacity duration-150",
        )}
      />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={description ? descriptionId : undefined}
        tabIndex={-1}
        className={cn(
          "relative w-full max-w-md space-y-4 rounded-2xl border border-cream-200 bg-white p-5 shadow-[0_24px_48px_-24px_rgba(33,29,24,0.35)] outline-none",
          open ? "animate-panel-in" : "opacity-0 transition-opacity duration-150",
        )}
      >
        <div className="space-y-1.5">
          <h2 id={titleId} className="text-base font-semibold text-ink-900">
            {title}
          </h2>
          {description && (
            <div id={descriptionId} className="text-sm text-ink-600">
              {description}
            </div>
          )}
        </div>
        {children}
      </div>
    </div>
  );
}

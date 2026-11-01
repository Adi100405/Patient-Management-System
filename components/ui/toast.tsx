"use client";

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { AlertTriangle, CheckCircle2, X } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * A tiny toast system (DESIGN.md §5). No dependency — a context, a fixed
 * region, and CSS enter animation (collapsed under reduced motion).
 *
 * A toast is never the *only* signal that a write failed: failed writes also
 * surface inline where the action lives.
 */
type ToastTone = "success" | "error";
type ToastItem = { id: number; title: string; description?: string; tone: ToastTone };
export type ToastInput = { title: string; description?: string; tone?: ToastTone };

const ToastContext = createContext<{ toast: (input: ToastInput) => void } | null>(null);

export function useToast() {
  const context = useContext(ToastContext);
  if (!context) throw new Error("useToast must be used inside <ToastProvider>");
  return context.toast;
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const sequence = useRef(0);

  const dismiss = useCallback((id: number) => {
    setItems((list) => list.filter((item) => item.id !== id));
  }, []);

  const toast = useCallback(
    (input: ToastInput) => {
      const id = (sequence.current += 1);
      setItems((list) => [
        ...list,
        { id, title: input.title, description: input.description, tone: input.tone ?? "success" },
      ]);
      setTimeout(() => dismiss(id), 5000);
    },
    [dismiss],
  );

  const value = useMemo(() => ({ toast }), [toast]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div className="pointer-events-none fixed inset-x-0 bottom-0 z-[60] flex flex-col items-stretch gap-2 p-4 sm:items-end">
        {items.map((item) => (
          <ToastCard key={item.id} item={item} onDismiss={() => dismiss(item.id)} />
        ))}
      </div>
    </ToastContext.Provider>
  );
}

function ToastCard({ item, onDismiss }: { item: ToastItem; onDismiss: () => void }) {
  const Icon = item.tone === "error" ? AlertTriangle : CheckCircle2;
  return (
    <div
      role={item.tone === "error" ? "alert" : "status"}
      className="animate-toast-in pointer-events-auto flex w-full max-w-sm items-start gap-3 rounded-2xl border border-cream-200 bg-white p-3.5 shadow-[0_24px_48px_-24px_rgba(33,29,24,0.35)]"
    >
      <span
        className={cn(
          "mt-0.5 grid h-6 w-6 shrink-0 place-items-center rounded-full",
          item.tone === "error" ? "bg-rose-50 text-rose-600" : "bg-teal-50 text-teal-700",
        )}
      >
        <Icon className="h-3.5 w-3.5" />
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium text-ink-900">{item.title}</p>
        {item.description && <p className="mt-0.5 text-xs text-ink-500">{item.description}</p>}
      </div>
      <button
        type="button"
        onClick={onDismiss}
        aria-label="Dismiss"
        className="grid h-6 w-6 shrink-0 place-items-center rounded-full text-ink-500 transition-colors hover:bg-cream-100 hover:text-ink-700"
      >
        <X className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}

"use client";

import { AlertCircle, CalendarPlus, CheckCircle2, Clock, Loader2, RefreshCw, XCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { isProposalExpired, type TrackedProposal } from "@/lib/assistant/chat-state";
import { cn } from "@/lib/utils";

const ACTION_META = {
  book: { Icon: CalendarPlus, label: "Booking" },
  reschedule: { Icon: RefreshCw, label: "Reschedule" },
  cancel: { Icon: XCircle, label: "Cancellation" },
} as const;

function expiryLabel(expiresAt: number): string {
  return new Intl.DateTimeFormat("en-IN", { hour: "numeric", minute: "2-digit" }).format(
    new Date(expiresAt),
  );
}

/**
 * One signed proposal as the person sees it: what will happen, with whom, when,
 * and the fee or refund line the model supplied from a real tool result. The
 * card never carries editable arguments - only the token - so the price and the
 * slot cannot be retyped in the browser.
 */
export function ConfirmationCard({
  tracked,
  onConfirm,
  onDecline,
}: {
  tracked: TrackedProposal;
  onConfirm: (proposalId: string) => void;
  onDecline: (proposalId: string) => void;
}) {
  const { proposal, status, note } = tracked;
  const { Icon, label } = ACTION_META[proposal.action];
  const expired = status === "pending" && isProposalExpired(proposal);
  const actionable = status === "pending" && !expired;

  return (
    <div
      className={cn(
        "rounded-2xl border bg-white p-3.5 shadow-[0_1px_2px_rgba(33,29,24,0.04)]",
        status === "confirmed"
          ? "border-teal-200"
          : status === "failed"
            ? "border-rose-200"
            : "border-cream-200",
      )}
    >
      <div className="flex items-start gap-2.5">
        <span
          aria-hidden="true"
          className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-teal-50 text-teal-700 ring-1 ring-inset ring-teal-100"
        >
          <Icon className="h-4 w-4" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-[10px] font-semibold uppercase tracking-wide text-ink-500">{label}</p>
          <p className="text-sm font-semibold text-ink-900">{proposal.title}</p>
          <p className="mt-0.5 text-xs leading-relaxed text-ink-600">{proposal.summary}</p>
        </div>
      </div>

      {proposal.details.length > 0 && (
        <ul className="mt-2.5 space-y-1 rounded-xl bg-cream-50 px-3 py-2">
          {proposal.details.map((detail) => (
            <li key={detail} className="flex items-start gap-1.5 text-[11px] leading-relaxed text-ink-600">
              <span aria-hidden="true" className="mt-1.5 h-1 w-1 shrink-0 rounded-full bg-teal-600" />
              {detail}
            </li>
          ))}
        </ul>
      )}

      {actionable && (
        <div className="mt-3 flex gap-2">
          <Button size="sm" type="button" className="flex-1" onClick={() => onConfirm(proposal.id)}>
            Confirm
          </Button>
          <Button
            size="sm"
            type="button"
            variant="ghost"
            onClick={() => onDecline(proposal.id)}
          >
            Decline
          </Button>
        </div>
      )}

      <div aria-live="polite" className="mt-2">
        {status === "pending" && !expired && (
          <p className="flex items-center gap-1.5 text-[11px] text-ink-500">
            <Clock className="h-3 w-3" aria-hidden="true" />
            Expires at {expiryLabel(proposal.expiresAt)} — nothing changes until you tap Confirm.
          </p>
        )}
        {status === "working" && (
          <p className="flex items-center gap-1.5 text-[11px] text-ink-600">
            <Loader2 className="h-3 w-3 motion-safe:animate-spin" aria-hidden="true" />
            Checking the slot and applying the change…
          </p>
        )}
        {status === "confirmed" && (
          <p className="flex items-start gap-1.5 text-[11px] font-medium text-teal-800">
            <CheckCircle2 className="mt-0.5 h-3 w-3 shrink-0" aria-hidden="true" />
            {note ?? "Done. The change is written."}
          </p>
        )}
        {status === "declined" && (
          <p className="text-[11px] text-ink-500">Declined — nothing was changed.</p>
        )}
        {status === "expired" && (
          <p className="flex items-start gap-1.5 text-[11px] text-amber-800">
            <Clock className="mt-0.5 h-3 w-3 shrink-0" aria-hidden="true" />
            {note ?? "This card expired. Ask me again and I will re-check the slot."}
          </p>
        )}
        {status === "failed" && (
          <p className="flex items-start gap-1.5 text-[11px] text-rose-700">
            <AlertCircle className="mt-0.5 h-3 w-3 shrink-0" aria-hidden="true" />
            {note ?? "That did not go through. Ask me to check again."}
          </p>
        )}
      </div>
    </div>
  );
}

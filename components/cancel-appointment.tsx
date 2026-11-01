"use client";

import { useState, useTransition } from "react";
import { cancelAppointment } from "@/actions/booking";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { useToast } from "@/components/ui/toast";
import type { CancelPreview } from "@/lib/cancel-preview";

/**
 * Cancel an appointment through a real confirmation (DESIGN.md §5).
 *
 * The dialog names what is being cancelled and what the refund policy will do
 * *before* committing, then calls the same `cancelAppointment` action as before
 * — the money path is untouched, only the interaction around it changes. On
 * success the page revalidates and a toast confirms it; on failure an error
 * toast appears and the appointment is left alone.
 */
export function CancelAppointment({
  appointmentId,
  subject,
  preview,
  clinicCancellation = false,
  variant = "ghost",
}: {
  appointmentId: number;
  subject: string;
  preview: CancelPreview;
  clinicCancellation?: boolean;
  variant?: "ghost" | "outline" | "subtle";
}) {
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const toast = useToast();

  const close = () => {
    if (!pending) setOpen(false);
  };

  const confirm = () => {
    const formData = new FormData();
    formData.set("appointmentId", String(appointmentId));
    startTransition(async () => {
      try {
        await cancelAppointment(formData);
        setOpen(false);
        toast({
          title: "Appointment cancelled",
          description: preview.headline,
          tone: "success",
        });
      } catch {
        toast({
          title: "Couldn't cancel this appointment",
          description: "Please try again in a moment.",
          tone: "error",
        });
      }
    });
  };

  return (
    <>
      <Button variant={variant} size="sm" type="button" onClick={() => setOpen(true)}>
        Cancel
      </Button>
      <Dialog open={open} onClose={close} title="Cancel this appointment?" description={subject}>
        <div className="rounded-xl border border-cream-200 bg-cream-50/70 p-3.5">
          <p className="text-sm font-medium text-ink-800">{preview.headline}</p>
          <p className="mt-0.5 text-xs leading-relaxed text-ink-500">{preview.detail}</p>
        </div>
        <p className="text-xs leading-relaxed text-ink-500">
          {clinicCancellation
            ? "The patient is notified and refunded, and their slot reopens."
            : "This frees your slot and cannot be undone. You can book again at any time."}
        </p>
        <div className="flex flex-col-reverse items-stretch gap-2 sm:flex-row sm:justify-end">
          <Button variant="ghost" size="sm" type="button" onClick={close} disabled={pending}>
            Keep appointment
          </Button>
          <Button variant="danger" size="sm" type="button" onClick={confirm} loading={pending}>
            Cancel appointment
          </Button>
        </div>
      </Dialog>
    </>
  );
}

import { NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { cancelAppointment, bookAppointment, rescheduleAppointment } from "@/actions/booking";
import { getDb } from "@/db";
import { appointments } from "@/db/schema";
import { consumeProposal, verifyProposal } from "@/lib/assistant/propose";
import { getSession } from "@/lib/session";

/**
 * The only place a proposal becomes a write.
 *
 * The chat endpoint can prepare a booking, a move or a cancellation, but it can
 * only hand the browser a signed token. This route verifies that token -
 * signature, five-minute expiry, role, and identity against the signed session -
 * and then calls the real server action. Everything the action already does
 * keeps working unchanged: slot revalidation, the seat-race retry, revalidation
 * of the dashboards, notifications and refunds.
 *
 * A token is spent before its action runs. If the action then fails (the slot
 * was taken while the card was on screen, say), the card cannot be tapped twice;
 * the honest answer is to ask the assistant to check again, which mints a fresh
 * proposal against fresh state.
 */
export const dynamic = "force-dynamic";

const ACTION_LABEL = {
  book: "booking",
  reschedule: "reschedule",
  cancel: "cancellation",
} as const;

type ConfirmRequest = { token?: unknown };

function errorResponse(message: string, status: number) {
  return NextResponse.json({ error: message }, { status });
}

function argNumber(args: Record<string, unknown>, key: string): number | null {
  const value = args[key];
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : null;
}

function argString(args: Record<string, unknown>, key: string): string | null {
  const value = args[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export async function POST(request: Request) {
  const session = await getSession();
  if (!session) {
    return errorResponse("Unauthorized", 401);
  }

  const body = (await request.json().catch(() => null)) as ConfirmRequest | null;
  const token = typeof body?.token === "string" ? body.token : "";
  if (!token) {
    return errorResponse("That confirmation could not be read.", 400);
  }

  const proposal = await verifyProposal(token);
  if (!proposal) {
    return errorResponse(
      "That confirmation is no longer valid — it expired or was changed. Ask me again and I will re-check the slot.",
      410,
    );
  }

  // Identity is inside the signature, but the session is the authority: a
  // proposal minted for another account is refused even if the signature holds.
  if (proposal.userId !== session.userId || proposal.role !== session.role) {
    return errorResponse("That confirmation belongs to another session.", 403);
  }

  // These three actions are patient actions; a doctor token is not a thing the
  // toolset mints, and must not become one by accident.
  if (session.role !== "patient") {
    return errorResponse("Only a patient can confirm this action.", 403);
  }

  if (!consumeProposal(proposal.id, proposal.expiresAt)) {
    return errorResponse(
      "That confirmation was already used. Ask me again if you need another change.",
      409,
    );
  }

  try {
    if (proposal.action === "book") {
      const doctorId = argNumber(proposal.args, "doctorId");
      const availabilityId = argNumber(proposal.args, "availabilityId");
      const date = argString(proposal.args, "date");
      const time = argString(proposal.args, "time");
      const reason = argString(proposal.args, "reason");

      if (!doctorId || !availabilityId || !date || !time) {
        return errorResponse("That booking is missing a detail and was not made.", 422);
      }

      const formData = new FormData();
      formData.set("doctorId", String(doctorId));
      formData.set("availabilityId", String(availabilityId));
      formData.set("date", date);
      formData.set("time", time);
      if (reason) formData.set("reason", reason);

      const result = await bookAppointment(null, formData);
      if (!result) {
        return errorResponse("The booking could not be made. Please try again.", 422);
      }
      if (result.error) {
        return errorResponse(result.error, 422);
      }

      return NextResponse.json({
        ok: true,
        action: "book",
        message: result.message ?? "Your appointment is booked.",
        appointmentId: result.appointmentId ?? null,
        // `online: true` means the visit is held pending payment; the UI renders
        // the existing Razorpay checkout inline for it.
        payment: result.payment ?? null,
      });
    }

    if (proposal.action === "reschedule") {
      const appointmentId = argNumber(proposal.args, "appointmentId");
      const date = argString(proposal.args, "date");
      const time = argString(proposal.args, "time");

      if (!appointmentId || !date || !time) {
        return errorResponse("That reschedule is missing a detail and was not made.", 422);
      }

      const formData = new FormData();
      formData.set("appointmentId", String(appointmentId));
      formData.set("date", date);
      formData.set("time", time);

      const result = await rescheduleAppointment(null, formData);
      if (!result) {
        return errorResponse("The reschedule could not be made. Please try again.", 422);
      }
      if (result.error) {
        return errorResponse(result.error, 422);
      }

      return NextResponse.json({
        ok: true,
        action: "reschedule",
        message: result.message ?? "Your appointment is moved.",
        appointmentId,
      });
    }

    const appointmentId = argNumber(proposal.args, "appointmentId");
    if (!appointmentId) {
      return errorResponse("That cancellation is missing a detail and was not made.", 422);
    }

    const formData = new FormData();
    formData.set("appointmentId", String(appointmentId));

    // `cancelAppointment` returns nothing: refusals (not yours, already
    // resolved) are silent by design in the UI action. The status row is the
    // honest answer, so it is re-read rather than assumed.
    await cancelAppointment(formData);

    const db = getDb();
    const [row] = await db
      .select({ status: appointments.status })
      .from(appointments)
      .where(
        and(
          eq(appointments.id, appointmentId),
          eq(appointments.patientId, session.profileId),
        ),
      )
      .limit(1);

    if (row?.status !== "cancelled") {
      return errorResponse(
        "That visit could not be cancelled — it may already be completed or was changed. Open your dashboard to check.",
        422,
      );
    }

    return NextResponse.json({
      ok: true,
      action: "cancel",
      message: "Your appointment is cancelled. Any refund follows the clinic's policy.",
      appointmentId,
    });
  } catch (error) {
    console.error(
      `[assistant] confirm ${ACTION_LABEL[proposal.action]} failed:`,
      error instanceof Error ? error.message : error,
    );
    return errorResponse(
      "The change could not be completed. Nothing partial was written; ask me to check again.",
      500,
    );
  }
}

import Link from "next/link";
import { notFound } from "next/navigation";
import { desc, eq } from "drizzle-orm";
import { ArrowLeft, CalendarDays, Phone, UserRound } from "lucide-react";
import { getDb } from "@/db";
import { appointments, doctors, patients, visitNotes } from "@/db/schema";
import { MedicalHistoryCard } from "@/components/medical-history-card";
import { MedicalHistoryForm } from "@/components/medical-history-form";
import { VisitHistory } from "@/components/visit-history";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  doctorCanAccessPatient,
  medicalHistoryRevisions,
} from "@/lib/medical-history-data";
import { requireRole } from "@/lib/session";
import { formatDate } from "@/lib/utils";

export const dynamic = "force-dynamic";
export const metadata = { title: "Patient record — Medrella" };

export default async function DoctorPatientRecordPage({
  params,
}: {
  params: Promise<{ patientId: string }>;
}) {
  const session = await requireRole("doctor");
  const { patientId: rawPatientId } = await params;
  const patientId = Number(rawPatientId);

  if (!Number.isInteger(patientId) || patientId <= 0) notFound();

  // Access is a care relationship, not a guessable id. A doctor who has never
  // had an appointment with this patient gets the same not-found page as a
  // patient who does not exist — the page never confirms the record to them.
  if (!(await doctorCanAccessPatient(session.profileId, patientId))) notFound();

  const db = getDb();
  const [patient] = await db
    .select({
      id: patients.id,
      fullName: patients.fullName,
      phone: patients.phone,
      dateOfBirth: patients.dateOfBirth,
      gender: patients.gender,
    })
    .from(patients)
    .where(eq(patients.id, patientId))
    .limit(1);

  if (!patient) notFound();

  const [revisions, visits] = await Promise.all([
    medicalHistoryRevisions(patientId),
    db
      .select({
        id: appointments.id,
        date: appointments.appointmentDate,
        time: appointments.appointmentTime,
        status: appointments.status,
        reason: appointments.reason,
        tokenNumber: appointments.tokenNumber,
        doctorName: doctors.fullName,
        specialization: doctors.specialization,
        diagnosis: visitNotes.diagnosis,
        summary: visitNotes.summary,
        aftercare: visitNotes.aftercare,
        followUpDays: visitNotes.followUpDays,
      })
      .from(appointments)
      .innerJoin(doctors, eq(appointments.doctorId, doctors.id))
      .leftJoin(visitNotes, eq(visitNotes.appointmentId, appointments.id))
      .where(eq(appointments.patientId, patientId))
      .orderBy(
        desc(appointments.appointmentDate),
        desc(appointments.appointmentTime),
        desc(appointments.id),
      ),
  ]);

  const current = revisions[0] ?? null;

  return (
    <div className="space-y-6">
      <div>
        <Link
          href="/dashboard/doctor"
          className="inline-flex items-center gap-1.5 text-sm font-medium text-teal-700 transition-colors hover:text-teal-800"
        >
          <ArrowLeft className="h-4 w-4" aria-hidden="true" />
          Back to my dashboard
        </Link>
      </div>

      <Card>
        <CardContent className="flex flex-col gap-4 p-5 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-start gap-4">
            <span
              aria-hidden="true"
              className="grid h-14 w-14 shrink-0 place-items-center rounded-full bg-teal-50 text-base font-semibold text-teal-800 ring-1 ring-inset ring-teal-100"
            >
              {initials(patient.fullName)}
            </span>
            <div>
              <h1 className="text-xl font-semibold tracking-tight text-ink-900">
                {patient.fullName}
              </h1>
              <p className="mt-0.5 text-sm text-ink-500">Patient record</p>
              <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-ink-600">
                {patient.gender && (
                  <span className="inline-flex items-center gap-1.5 rounded-full bg-cream-100 px-2.5 py-1 ring-1 ring-inset ring-cream-200">
                    <UserRound className="h-3.5 w-3.5 text-ink-500" aria-hidden="true" />
                    {patient.gender}
                  </span>
                )}
                {patient.dateOfBirth && (
                  <span className="inline-flex items-center gap-1.5 rounded-full bg-cream-100 px-2.5 py-1 ring-1 ring-inset ring-cream-200">
                    <CalendarDays className="h-3.5 w-3.5 text-ink-500" aria-hidden="true" />
                    Born {formatDate(patient.dateOfBirth)}
                  </span>
                )}
                {patient.phone && (
                  <span className="inline-flex items-center gap-1.5 rounded-full bg-cream-100 px-2.5 py-1 ring-1 ring-inset ring-cream-200">
                    <Phone className="h-3.5 w-3.5 text-ink-500" aria-hidden="true" />
                    {patient.phone}
                  </span>
                )}
              </div>
            </div>
          </div>
        </CardContent>
      </Card>

      <MedicalHistoryCard revisions={revisions} />

      <Card>
        <CardHeader>
          <CardTitle>Update medical history</CardTitle>
          <p className="text-sm text-ink-500">
            Saving adds a new revision. Earlier versions stay in the record with who
            changed what, and when.
          </p>
        </CardHeader>
        <CardContent>
          <MedicalHistoryForm
            key={current?.id ?? "empty"}
            patientId={patientId}
            initial={current ?? emptyRecord}
          />
        </CardContent>
      </Card>

      <VisitHistory rows={visits} />
    </div>
  );
}

/** "Riya Sharma" -> "RS". */
function initials(fullName: string) {
  return fullName
    .replace(/^Dr\.?\s+/i, "")
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? "")
    .join("");
}

const emptyRecord = {
  bloodGroup: null,
  allergies: null,
  conditions: null,
  medications: null,
  notes: null,
} as const;

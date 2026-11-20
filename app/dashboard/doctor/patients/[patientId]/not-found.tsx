import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";

/**
 * The page for a patient outside the doctor's care (or an id that does not
 * exist). It deliberately does not say which, so it cannot confirm a record to
 * somebody who has no relationship with the patient.
 */
export default function PatientRecordNotFound() {
  return (
    <Card className="mx-auto mt-10 max-w-md p-8 text-center">
      <p className="text-xs font-semibold uppercase tracking-wide text-teal-700">
        Patient record
      </p>
      <h1 className="mt-2 text-2xl font-semibold tracking-tight text-ink-900">
        Not in your care
      </h1>
      <p className="mt-2 text-sm text-ink-500">
        This patient is not part of your care, or the link is out of date. Records
        open only for a patient you have an appointment with.
      </p>
      <div className="mt-6 flex justify-center">
        <Link href="/dashboard/doctor">
          <Button type="button">Back to my dashboard</Button>
        </Link>
      </div>
    </Card>
  );
}

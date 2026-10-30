import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";

/** One calm page for every wrong turn, in the same warm room as the rest. */
export default function NotFound() {
  return (
    <Card className="mx-auto mt-10 max-w-md p-8 text-center">
      <p className="text-xs font-semibold uppercase tracking-wide text-teal-700">Page not found</p>
      <h1 className="mt-2 text-2xl font-semibold tracking-tight text-ink-900">
        This page has moved on
      </h1>
      <p className="mt-2 text-sm text-ink-500">
        The link may be old or mistyped. Your appointments and receipts are safe.
      </p>
      <div className="mt-6 flex flex-wrap justify-center gap-3">
        <Link href="/dashboard/patient">
          <Button type="button">Go to my appointments</Button>
        </Link>
        <Link href="/doctors">
          <Button variant="outline" type="button">
            Find a doctor
          </Button>
        </Link>
      </div>
    </Card>
  );
}

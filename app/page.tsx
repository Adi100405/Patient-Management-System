import Link from "next/link";
import { getDb } from "@/db";
import { doctors } from "@/db/schema";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { formatCurrency } from "@/lib/utils";

export const dynamic = "force-dynamic";

export default async function HomePage() {
  const db = getDb();
  const featured = await db.select().from(doctors).limit(3);

  return (
    <div className="space-y-16">
      <section className="grid gap-8 pt-6 md:grid-cols-2 md:items-center">
        <div className="space-y-5">
          <Badge variant="booked">Same-day appointments available</Badge>
          <h1 className="text-4xl font-bold tracking-tight text-ink-900 sm:text-5xl">
            Book a doctor in{" "}
            <span className="text-teal-700">under a minute</span>
          </h1>
          <p className="max-w-lg text-lg text-ink-600">
            Find the right specialist, pick a slot that fits your day, and manage every
            appointment from one dashboard. Doctors see bookings the moment they are made.
          </p>
          <div className="flex flex-wrap gap-3">
            <Link href="/doctors">
              <Button size="lg" type="button">
                Find a doctor
              </Button>
            </Link>
            <Link href="/sign-up">
              <Button size="lg" variant="outline" type="button">
                Create an account
              </Button>
            </Link>
          </div>
        </div>

        <Card className="bg-gradient-to-br from-teal-700 to-teal-900 text-white">
          <CardHeader>
            <CardTitle className="text-white">How it works</CardTitle>
          </CardHeader>
          <CardContent>
            <ol className="space-y-4 text-sm">
              {[
                "Create a patient account in seconds.",
                "Browse doctors by specialization and fee.",
                "Pick a free slot from the doctor's live availability.",
                "Your appointment appears instantly in both dashboards.",
              ].map((step, i) => (
                <li key={step} className="flex gap-3">
                  <span className="grid h-6 w-6 shrink-0 place-items-center rounded-full bg-white/20 text-xs font-semibold">
                    {i + 1}
                  </span>
                  <span className="text-teal-50">{step}</span>
                </li>
              ))}
            </ol>
          </CardContent>
        </Card>
      </section>

      <section className="space-y-5">
        <div className="flex items-end justify-between gap-4">
          <div>
            <h2 className="text-2xl font-semibold tracking-tight">Featured doctors</h2>
            <p className="text-sm text-ink-600">Verified specialists accepting new patients.</p>
          </div>
          <Link href="/doctors" className="text-sm font-medium text-teal-700 hover:underline">
            View all →
          </Link>
        </div>

        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {featured.map((doctor) => (
            <Link key={doctor.id} href={`/doctors/${doctor.id}`}>
              <Card className="h-full transition hover:border-teal-300 hover:shadow-[0_10px_30px_-12px_rgba(33,29,24,0.18)]">
                <CardHeader>
                  <CardTitle>{doctor.fullName}</CardTitle>
                  <p className="text-sm font-medium text-teal-700">{doctor.specialization}</p>
                </CardHeader>
                <CardContent className="space-y-1 text-sm text-ink-600">
                  <p>{doctor.experienceYears} years experience</p>
                  <p>
                    Consultation fee:{" "}
                    <span className="font-medium text-ink-900">
                      {formatCurrency(doctor.consultationFee)}
                    </span>
                  </p>
                </CardContent>
              </Card>
            </Link>
          ))}
        </div>
      </section>
    </div>
  );
}

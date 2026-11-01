import Link from "next/link";
import { unstable_cache } from "next/cache";
import { BadgeCheck, CalendarClock, ShieldCheck } from "lucide-react";
import { getDb } from "@/db";
import { doctors } from "@/db/schema";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { formatCurrency } from "@/lib/utils";

export const dynamic = "force-dynamic";

/**
 * The featured strip rarely changes, so it is cached for five minutes. The page
 * itself stays dynamic because the header reads the session cookie; this just
 * takes the database round trip off the critical path of the landing page.
 */
const getFeaturedDoctors = unstable_cache(
  async () => getDb().select().from(doctors).limit(3),
  ["featured-doctors"],
  { revalidate: 300 },
);

const TRUST = [
  { label: "Verified specialists", Icon: BadgeCheck },
  { label: "Live slot availability", Icon: CalendarClock },
  { label: "Secure payments", Icon: ShieldCheck },
];

const STEPS = [
  { title: "Create an account", body: "Sign up as a patient in seconds." },
  { title: "Find your doctor", body: "Browse by specialty, fee and experience." },
  { title: "Pick a free slot", body: "Book straight from live availability." },
  {
    title: "Confirm and pay",
    body: "Pay online or at the clinic — your receipt is always ready.",
  },
];

export default async function HomePage() {
  const featured = await getFeaturedDoctors();

  return (
    <div className="space-y-16">
      <section className="relative isolate overflow-hidden rounded-3xl border border-cream-200 bg-white px-6 py-12 sm:px-10 sm:py-14">
        <div
          aria-hidden="true"
          className="pointer-events-none absolute -right-24 -top-24 h-72 w-72 rounded-full bg-teal-100/70 blur-3xl"
        />
        <div
          aria-hidden="true"
          className="pointer-events-none absolute -bottom-32 -left-20 h-72 w-72 rounded-full bg-cream-200/70 blur-3xl"
        />

        <div className="relative grid gap-10 lg:grid-cols-[1.1fr_0.9fr] lg:items-center">
          <div className="space-y-6">
            <Badge variant="booked">Same-day appointments available</Badge>
            <h1 className="text-balance text-4xl font-bold tracking-tight text-ink-900 sm:text-5xl lg:text-[3.25rem] lg:leading-[1.05]">
              Book a doctor in <span className="text-teal-700">under a minute</span>
            </h1>
            <p className="max-w-lg text-lg leading-relaxed text-ink-600">
              Find the right specialist, pick a slot that fits your day, and keep every
              appointment, payment and receipt in one calm place.
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
            <ul className="flex flex-wrap gap-x-6 gap-y-2 pt-1 text-sm text-ink-600">
              {TRUST.map((item) => (
                <li key={item.label} className="flex items-center gap-2">
                  <item.Icon className="h-4 w-4 text-teal-700" aria-hidden="true" />
                  {item.label}
                </li>
              ))}
            </ul>
          </div>

          <Card className="border-teal-900/20 bg-gradient-to-br from-teal-700 to-teal-900 text-white shadow-[0_24px_48px_-24px_rgba(6,75,70,0.55)]">
            <CardHeader>
              <CardTitle className="text-white">How it works</CardTitle>
              <p className="text-sm text-teal-100/90">From search to a confirmed slot, in four steps.</p>
            </CardHeader>
            <CardContent>
              <ol className="space-y-4">
                {STEPS.map((step, index) => (
                  <li key={step.title} className="flex gap-3">
                    <span
                      aria-hidden="true"
                      className="grid h-7 w-7 shrink-0 place-items-center rounded-full bg-white/15 text-xs font-semibold ring-1 ring-inset ring-white/25"
                    >
                      {index + 1}
                    </span>
                    <div>
                      <p className="text-sm font-medium text-white">{step.title}</p>
                      <p className="text-sm text-teal-50/85">{step.body}</p>
                    </div>
                  </li>
                ))}
              </ol>
            </CardContent>
          </Card>
        </div>
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
              <Card interactive className="h-full">
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

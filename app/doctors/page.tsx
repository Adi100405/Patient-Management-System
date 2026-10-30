import Link from "next/link";
import { ilike, or } from "drizzle-orm";
import { getDb } from "@/db";
import { doctors } from "@/db/schema";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { formatCurrency } from "@/lib/utils";

export const dynamic = "force-dynamic";

export default async function DoctorsPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string }>;
}) {
  const { q } = await searchParams;
  const term = q?.trim() ?? "";
  const db = getDb();

  const rows = term
    ? await db
        .select()
        .from(doctors)
        .where(or(ilike(doctors.fullName, `%${term}%`), ilike(doctors.specialization, `%${term}%`)))
    : await db.select().from(doctors);

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Find a doctor</h1>
          <p className="text-sm text-ink-600">
            {rows.length} {rows.length === 1 ? "doctor" : "doctors"} available
            {term ? ` for “${term}”` : ""}.
          </p>
        </div>

        <form className="flex w-full max-w-sm gap-2" action="/doctors">
          <Input name="q" defaultValue={term} placeholder="Search name or specialization" />
          <Button type="submit" variant="outline">
            Search
          </Button>
        </form>
      </div>

      {rows.length === 0 ? (
        <Card>
          <CardContent className="py-10 text-center text-sm text-ink-600">
            No doctors matched that search. Try “cardiology”, “dermatology”, or a name.
            <div className="mt-4">
              <Link href="/doctors">
                <Button variant="outline" size="sm" type="button">
                  Clear search
                </Button>
              </Link>
            </div>
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {rows.map((doctor) => (
            <Card key={doctor.id} className="flex h-full flex-col">
              <CardHeader>
                <div className="flex items-start justify-between gap-2">
                  <CardTitle>{doctor.fullName}</CardTitle>
                  <Badge variant="booked">Verified</Badge>
                </div>
                <p className="text-sm font-medium text-teal-700">{doctor.specialization}</p>
              </CardHeader>
              <CardContent className="flex flex-1 flex-col justify-between gap-4">
                <div className="space-y-1 text-sm text-ink-600">
                  <p>{doctor.experienceYears} years experience</p>
                  <p>{doctor.qualification ?? "MBBS"}</p>
                  <p>
                    Fee:{" "}
                    <span className="font-medium text-ink-900">
                      {formatCurrency(doctor.consultationFee)}
                    </span>
                  </p>
                </div>
                <Link href={`/doctors/${doctor.id}`}>
                  <Button className="w-full" type="button">
                    View slots
                  </Button>
                </Link>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}

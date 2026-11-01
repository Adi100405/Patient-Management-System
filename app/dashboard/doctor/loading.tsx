import { Card } from "@/components/ui/card";

/**
 * First-paint placeholder for the doctor dashboard. Same rhythm as the real
 * page (title, KPI strip, availability, schedule rows) so nothing jumps when
 * the data arrives.
 */
export default function DoctorDashboardLoading() {
  return (
    <div className="animate-pulse space-y-6" aria-busy="true" aria-label="Loading your schedule">
      <div className="space-y-2">
        <div className="h-7 w-56 rounded-lg bg-cream-200" />
        <div className="h-4 w-80 max-w-full rounded-lg bg-cream-100" />
      </div>

      <Card className="overflow-hidden">
        <div className="grid grid-cols-2 divide-cream-200 sm:grid-cols-4 sm:divide-x">
          {Array.from({ length: 4 }).map((_, index) => (
            <div key={index} className="flex items-center gap-3 p-4 sm:p-5">
              <div className="h-9 w-9 shrink-0 rounded-xl bg-cream-100" />
              <div className="w-full space-y-2">
                <div className="h-2.5 w-20 rounded bg-cream-100" />
                <div className="h-5 w-10 rounded bg-cream-200" />
              </div>
            </div>
          ))}
        </div>
      </Card>

      <Card>
        <div className="space-y-2 p-5">
          <div className="h-5 w-40 rounded bg-cream-200" />
          <div className="h-3.5 w-72 max-w-full rounded bg-cream-100" />
        </div>
        <div className="space-y-3 px-5 pb-5">
          {Array.from({ length: 4 }).map((_, index) => (
            <div key={index} className="h-12 rounded-xl border border-cream-200 bg-cream-50/60" />
          ))}
        </div>
      </Card>

      <Card>
        <div className="space-y-2 p-5">
          <div className="h-5 w-24 rounded bg-cream-200" />
          <div className="h-3.5 w-64 max-w-full rounded bg-cream-100" />
        </div>
        <div className="space-y-3 px-5 pb-5">
          {Array.from({ length: 3 }).map((_, index) => (
            <div key={index} className="rounded-xl border border-cream-200 p-4">
              <div className="flex items-start gap-3">
                <div className="h-10 w-10 shrink-0 rounded-full bg-cream-100" />
                <div className="w-full space-y-2">
                  <div className="h-4 w-40 max-w-full rounded bg-cream-200" />
                  <div className="h-6 w-48 rounded-full bg-cream-100" />
                </div>
              </div>
            </div>
          ))}
        </div>
      </Card>
    </div>
  );
}
"use client";

import { useActionState, useEffect, useState } from "react";
import { X } from "lucide-react";
import {
  addAvailability,
  removeAvailability,
  type AvailabilityState,
} from "@/actions/availability";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { MAX_BLOCK_DATES, type SchedulingType } from "@/lib/schedule";
import { clinicNow } from "@/lib/slots";
import { cn, formatDate, formatTime } from "@/lib/utils";

const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

export type AvailabilityRow = {
  readonly id: number;
  readonly schedulingType: SchedulingType;
  /** Null for a block that follows an explicit date list. */
  readonly dayOfWeek: number | null;
  readonly dates: readonly string[];
  readonly startTime: string;
  readonly endTime: string;
  readonly slotMinutes: number;
  readonly capacity: number;
};

const selectClass =
  "flex h-10 w-full rounded-xl border border-cream-300 bg-white px-3 text-sm text-ink-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal-600";

/**
 * The doctor's schedule editor.
 *
 * A block is either a wave (patients share a slot) or a stream (the whole
 * window books as one start–end item), and it either repeats every week or
 * opens on a list of dates. One date is a single visit day; several are a
 * recurring series.
 */
export function AvailabilityManager({
  windows,
  lockedIds,
}: {
  windows: AvailabilityRow[];
  lockedIds: number[];
}) {
  const [state, formAction, pending] = useActionState<AvailabilityState, FormData>(
    addAvailability,
    null,
  );
  const locked = new Set(lockedIds);

  const [type, setType] = useState<SchedulingType>("wave");
  const [recurrence, setRecurrence] = useState<"weekly" | "dates">("weekly");
  const [dates, setDates] = useState<string[]>([]);
  const [draft, setDraft] = useState("");

  const confirmed = state?.message;
  useEffect(() => {
    if (!confirmed) return;
    setDates([]);
    setDraft("");
  }, [confirmed]);

  const weekly = windows.filter((window) => window.dayOfWeek !== null);
  const dated = windows.filter((window) => window.dayOfWeek === null);

  const addDate = () => {
    if (!draft || dates.includes(draft)) return;
    if (dates.length >= MAX_BLOCK_DATES) return;
    setDates([...dates, draft]);
    setDraft("");
  };

  return (
    <div className="space-y-5">
      {windows.length === 0 ? (
        <p className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-800">
          You haven&apos;t published any availability yet, so patients can&apos;t book you.
          Add your first window below.
        </p>
      ) : (
        <div className="space-y-4">
          {weekly.length > 0 && (
            <ul className="space-y-2">
              {weekly.map((window) => (
                <BlockRow
                  key={window.id}
                  window={window}
                  locked={locked.has(window.id)}
                />
              ))}
            </ul>
          )}

          {dated.length > 0 && (
            <div className="space-y-2">
              <p className="text-[11px] font-semibold uppercase tracking-wide text-ink-500">
                Specific dates
              </p>
              <ul className="space-y-2">
                {dated.map((window) => (
                  <BlockRow
                    key={window.id}
                    window={window}
                    locked={locked.has(window.id)}
                  />
                ))}
              </ul>
            </div>
          )}
        </div>
      )}

      {state?.message && (
        <p className="rounded-xl border border-teal-200 bg-teal-50 p-3 text-sm text-teal-800">{state.message}</p>
      )}
      {state?.error && (
        <p className="rounded-xl border border-rose-200 bg-rose-50 p-3 text-sm text-rose-700">{state.error}</p>
      )}

      <form
        key={windows.length}
        action={formAction}
        className="grid gap-3 rounded-xl border border-dashed border-cream-300 bg-cream-50/70 p-4 sm:grid-cols-6"
      >
        <input type="hidden" name="schedulingType" value={type} />
        <input type="hidden" name="recurrence" value={recurrence} />

        <div className="space-y-1.5 sm:col-span-3">
          <Label>Scheduling style</Label>
          <div className="flex rounded-xl border border-cream-300 bg-white p-1">
            {(["wave", "stream"] as const).map((option) => (
              <button
                key={option}
                type="button"
                onClick={() => setType(option)}
                aria-pressed={type === option}
                className={cn(
                  "flex-1 rounded-lg px-3 py-1.5 text-sm font-medium transition",
                  type === option
                    ? "bg-teal-700 text-white"
                    : "text-ink-600 hover:bg-teal-50",
                )}
              >
                {option === "wave" ? "Wave" : "Stream"}
              </button>
            ))}
          </div>
          <p className="text-xs text-ink-500">
            {type === "wave"
              ? "Patients share a slot. The capacity is per slot."
              : "Patients book the whole window as one start–end slot. The capacity is per window."}
          </p>
        </div>

        <div className="space-y-1.5 sm:col-span-3">
          <Label>Repeats</Label>
          <div className="flex rounded-xl border border-cream-300 bg-white p-1">
            {(
              [
                { value: "weekly", label: "Every week" },
                { value: "dates", label: "Specific dates" },
              ] as const
            ).map((option) => (
              <button
                key={option.value}
                type="button"
                onClick={() => setRecurrence(option.value)}
                aria-pressed={recurrence === option.value}
                className={cn(
                  "flex-1 rounded-lg px-3 py-1.5 text-sm font-medium transition",
                  recurrence === option.value
                    ? "bg-teal-700 text-white"
                    : "text-ink-600 hover:bg-teal-50",
                )}
              >
                {option.label}
              </button>
            ))}
          </div>
          <p className="text-xs text-ink-500">
            {recurrence === "weekly"
              ? "The same window every week on one day."
              : "One date is a single visit. Several dates repeat."}
          </p>
        </div>

        {recurrence === "weekly" ? (
          <div className="space-y-1.5 sm:col-span-2">
            <Label htmlFor="dayOfWeek">Day</Label>
            <select id="dayOfWeek" name="dayOfWeek" className={selectClass} defaultValue="1">
              {DAYS.map((day, index) => (
                <option key={day} value={index}>
                  {day}
                </option>
              ))}
            </select>
            {state?.errors?.dayOfWeek && (
              <p className="text-xs text-rose-600">{state.errors.dayOfWeek}</p>
            )}
          </div>
        ) : (
          <div className="space-y-1.5 sm:col-span-6">
            <Label htmlFor="dateDraft">Dates</Label>
            <div className="flex flex-wrap items-center gap-2">
              <Input
                id="dateDraft"
                type="date"
                value={draft}
                min={clinicNow().date}
                onChange={(event) => setDraft(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key !== "Enter") return;
                  event.preventDefault();
                  addDate();
                }}
                className="w-48"
              />
              <Button type="button" variant="outline" size="sm" onClick={addDate}>
                Add date
              </Button>
              {dates.map((date) => (
                <span
                  key={date}
                  className="inline-flex items-center gap-1.5 rounded-full bg-teal-50 py-1 pl-3 pr-1.5 text-xs font-medium text-teal-800 ring-1 ring-inset ring-teal-200"
                >
                  {formatDate(date)}
                  <button
                    type="button"
                    onClick={() => setDates(dates.filter((each) => each !== date))}
                    aria-label={`Remove ${formatDate(date)}`}
                    className="rounded-full p-0.5 text-teal-600 hover:bg-teal-100"
                  >
                    <X className="h-3 w-3" aria-hidden="true" />
                  </button>
                  <input type="hidden" name="dates" value={date} />
                </span>
              ))}
            </div>
            {state?.errors?.dates && (
              <p className="text-xs text-rose-600">{state.errors.dates}</p>
            )}
          </div>
        )}

        <div className="space-y-1.5 sm:col-span-2">
          <Label htmlFor="startTime">From</Label>
          <Input id="startTime" name="startTime" type="time" defaultValue="09:00" required />
        </div>

        <div className="space-y-1.5 sm:col-span-2">
          <Label htmlFor="endTime">To</Label>
          <Input id="endTime" name="endTime" type="time" defaultValue="13:00" required />
          {state?.errors?.endTime && (
            <p className="text-xs text-rose-600">{state.errors.endTime}</p>
          )}
        </div>

        {type === "wave" && (
          <div className="space-y-1.5 sm:col-span-2">
            <Label htmlFor="slotMinutes">Visit length</Label>
            <select id="slotMinutes" name="slotMinutes" className={selectClass} defaultValue="30">
              <option value="15">15 min</option>
              <option value="30">30 min</option>
              <option value="45">45 min</option>
              <option value="60">60 min</option>
            </select>
            {state?.errors?.slotMinutes && (
              <p className="text-xs text-rose-600">{state.errors.slotMinutes}</p>
            )}
          </div>
        )}

        <div className="space-y-1.5 sm:col-span-3">
          <Label htmlFor="capacity">
            {type === "wave" ? "Patients per slot" : "Patients in this window"}
          </Label>
          <Input
            id="capacity"
            name="capacity"
            type="number"
            min={1}
            max={50}
            defaultValue={1}
            required
          />
          {state?.errors?.capacity && (
            <p className="text-xs text-rose-600">{state.errors.capacity}</p>
          )}
        </div>

        <div className="flex items-end sm:col-span-3">
          <Button type="submit" disabled={pending} size="sm">
            {pending ? "Adding…" : "Add availability window"}
          </Button>
        </div>
      </form>
    </div>
  );
}

/** One published block: when it applies, how it is styled and how many it holds. */
function BlockRow({ window, locked }: { window: AvailabilityRow; locked: boolean }) {
  return (
    <li className="flex flex-col gap-2 rounded-xl border border-cream-200 p-3 sm:flex-row sm:items-center sm:justify-between">
      <div className="min-w-0">
        <p className="text-sm font-medium text-ink-900">
          {window.dayOfWeek !== null
            ? `${DAYS[window.dayOfWeek]} · ${formatTime(window.startTime)} – ${formatTime(window.endTime)}`
            : `${formatTime(window.startTime)} – ${formatTime(window.endTime)}`}
        </p>
        <p className="text-xs text-ink-500">
          {window.schedulingType === "wave"
            ? `Wave · ${window.capacity} ${window.capacity === 1 ? "patient" : "patients"} per slot · ${window.slotMinutes} min visit`
            : `Stream · ${window.capacity} ${window.capacity === 1 ? "patient" : "patients"} in this window`}
        </p>
        {window.dates.length > 0 && (
          <p className="mt-0.5 text-xs text-ink-500">
            {window.dates.map((date) => formatDate(date)).join(", ")}
          </p>
        )}
      </div>

      {locked ? (
        <span className="text-xs font-medium text-ink-500">
          Has upcoming bookings — cancel them to remove
        </span>
      ) : (
        <form action={removeAvailability}>
          <input type="hidden" name="availabilityId" value={window.id} />
          <Button variant="outline" size="sm" type="submit">
            Remove
          </Button>
        </form>
      )}
    </li>
  );
}

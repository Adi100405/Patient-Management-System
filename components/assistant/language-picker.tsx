"use client";

import { Languages } from "lucide-react";
import { isReplyLanguage, LANGUAGE_OPTIONS } from "@/lib/assistant/lang";
import type { ReplyLanguage } from "@/lib/assistant/types";

/**
 * A native select on purpose: it is the one control every phone renders well,
 * and the assistant header has no room for three full-width pills.
 */
export function LanguagePicker({
  value,
  onChange,
}: {
  value: ReplyLanguage;
  onChange: (value: ReplyLanguage) => void;
}) {
  return (
    <label className="relative inline-flex items-center">
      <span className="sr-only">Reply language</span>
      <Languages
        aria-hidden="true"
        className="pointer-events-none absolute left-2 h-3.5 w-3.5 text-ink-500"
      />
      <select
        value={value}
        onChange={(event) => {
          if (isReplyLanguage(event.target.value)) onChange(event.target.value);
        }}
        className="h-8 appearance-none rounded-lg border border-cream-300 bg-white pl-7 pr-2 text-xs font-medium text-ink-700 outline-none transition hover:bg-cream-50 focus-visible:ring-2 focus-visible:ring-teal-600"
      >
        {LANGUAGE_OPTIONS.map((option) => (
          <option key={option.id} value={option.id}>
            {option.label}
          </option>
        ))}
      </select>
    </label>
  );
}

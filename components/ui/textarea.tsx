import * as React from "react";
import { cn } from "@/lib/utils";

export function Textarea({ className, ...props }: React.TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return (
    <textarea
      className={cn(
        "flex min-h-20 w-full rounded-xl border border-cream-300 bg-white px-3 py-2 text-sm text-ink-900 placeholder:text-ink-500/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal-600",
        className,
      )}
      {...props}
    />
  );
}

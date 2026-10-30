import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

const badgeVariants = cva(
  "inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-medium ring-1 ring-inset",
  {
    variants: {
      variant: {
        default: "bg-cream-100 text-ink-700 ring-cream-200",
        booked: "bg-teal-50 text-teal-800 ring-teal-200",
        cancelled: "bg-rose-50 text-rose-700 ring-rose-200",
        completed: "bg-sky-50 text-sky-700 ring-sky-200",
        no_show: "bg-amber-50 text-amber-800 ring-amber-200",
        outline: "bg-transparent text-ink-600 ring-cream-300",
      },
    },
    defaultVariants: { variant: "default" },
  },
);

export function Badge({
  className,
  variant,
  ...props
}: React.HTMLAttributes<HTMLSpanElement> & VariantProps<typeof badgeVariants>) {
  return <span className={cn(badgeVariants({ variant }), className)} {...props} />;
}

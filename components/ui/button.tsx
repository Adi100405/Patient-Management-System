import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-xl text-sm font-medium transition-colors disabled:pointer-events-none disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal-600 focus-visible:ring-offset-2 focus-visible:ring-offset-cream-50",
  {
    variants: {
      variant: {
        default: "bg-teal-700 text-white shadow-sm hover:bg-teal-800",
        outline: "border border-cream-300 bg-white text-ink-800 hover:bg-cream-100",
        ghost: "text-ink-700 hover:bg-cream-100 hover:text-ink-900",
        danger: "bg-rose-600 text-white shadow-sm hover:bg-rose-700",
        subtle: "bg-teal-50 text-teal-800 ring-1 ring-inset ring-teal-200 hover:bg-teal-100",
      },
      size: {
        default: "h-10 px-4 py-2",
        sm: "h-8 rounded-lg px-3 text-xs",
        lg: "h-11 px-6 text-base",
        icon: "h-9 w-9",
      },
    },
    defaultVariants: { variant: "default", size: "default" },
  },
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {}

export function Button({ className, variant, size, ...props }: ButtonProps) {
  return <button className={cn(buttonVariants({ variant, size }), className)} {...props} />;
}

export { buttonVariants };

"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * A header link that shows where you are. Server components can't read the
 * path, so this thin client wrapper owns the active state (DESIGN.md §5).
 */
export function NavLink({
  href,
  children,
  externalLabel,
}: {
  href: string;
  children: ReactNode;
  /** Extra aria-label for links whose visible text is abbreviated on mobile. */
  externalLabel?: string;
}) {
  const pathname = usePathname();
  const active = pathname === href || pathname.startsWith(`${href}/`);

  return (
    <Link
      href={href}
      aria-current={active ? "page" : undefined}
      aria-label={externalLabel}
      className={cn(
        "rounded-xl px-2.5 py-2 text-sm font-medium transition-colors sm:px-3",
        active ? "bg-teal-50 text-teal-800" : "text-ink-700 hover:bg-cream-100 hover:text-ink-900",
      )}
    >
      {children}
    </Link>
  );
}

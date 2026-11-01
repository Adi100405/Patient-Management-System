import { Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";

/** The one loading indicator, so every async control spins the same way. */
export function Spinner({ className }: { className?: string }) {
  return <Loader2 aria-hidden="true" className={cn("h-4 w-4 animate-spin", className)} />;
}

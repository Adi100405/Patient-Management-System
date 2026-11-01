"use client";

import { Printer } from "lucide-react";
import { Button } from "@/components/ui/button";

/**
 * Prints the document - receipts are the one place patients still want paper.
 * "Save as PDF" is the same dialog in every browser, so one button covers both.
 */
export function PrintButton() {
  return (
    <Button type="button" onClick={() => window.print()} className="print:hidden">
      <Printer className="h-4 w-4" />
      Print / Save as PDF
    </Button>
  );
}

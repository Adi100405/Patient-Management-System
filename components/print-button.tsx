"use client";

/** Prints the document - receipts are the one place patients still want paper. */
export function PrintButton() {
  return (
    <button
      type="button"
      onClick={() => window.print()}
      className="rounded-xl border border-cream-300 px-3 py-1.5 text-sm font-medium text-ink-700 transition-colors hover:bg-cream-100 print:hidden"
    >
      Print receipt
    </button>
  );
}

"use client";

/**
 * Prints the document - receipts are the one place patients still want paper.
 * "Save as PDF" is the same dialog in every browser, so one button covers both.
 */
export function PrintButton() {
  return (
    <button
      type="button"
      onClick={() => window.print()}
      className="inline-flex items-center gap-2 rounded-xl bg-teal-700 px-3.5 py-2 text-sm font-medium text-white shadow-sm transition-colors hover:bg-teal-800 print:hidden"
    >
      <svg viewBox="0 0 20 20" fill="currentColor" aria-hidden="true" className="h-4 w-4">
        <path
          fillRule="evenodd"
          d="M5 2.75A.75.75 0 0 1 5.75 2h8.5a.75.75 0 0 1 .75.75V6h.25A2.75 2.75 0 0 1 18 8.75v4.5A2.75 2.75 0 0 1 15.25 16H15v1.25a.75.75 0 0 1-.75.75h-8.5a.75.75 0 0 1-.75-.75V16h-.25A2.75 2.75 0 0 1 2 13.25v-4.5A2.75 2.75 0 0 1 4.75 6H5V2.75ZM6.5 6h7V3.5h-7V6Zm-1.25 5.25a.75.75 0 1 0 0-1.5.75.75 0 0 0 0 1.5ZM7 10.5v5.5h6v-5.5H7Z"
          clipRule="evenodd"
        />
      </svg>
      Print / Save as PDF
    </button>
  );
}

import { describe, expect, it } from "vitest";
import { renderEmail } from "@/lib/notifications/email-layout";

describe("renderEmail", () => {
  it("renders a full document with the heading, details and call to action", () => {
    const html = renderEmail({
      heading: "Your appointment is booked",
      intro: "We have reserved your slot.",
      rows: [
        ["Doctor", "Dr. Kavita Rao"],
        ["When", "Mon, 2 Nov at 10:30 AM"],
      ],
      cta: { label: "View my appointments", url: "https://example.com/dashboard" },
      footnote: "Need to change it? Cancel from your dashboard.",
    });

    expect(html.startsWith("<!doctype html>")).toBe(true);
    expect(html).toContain("Your appointment is booked");
    expect(html).toContain("Dr. Kavita Rao");
    expect(html).toContain("Mon, 2 Nov at 10:30 AM");
    expect(html).toContain('href="https://example.com/dashboard"');
    expect(html).toContain("View my appointments");
    expect(html).toContain("Need to change it?");
  });

  it("escapes interpolated values so patient-entered text can never inject markup", () => {
    const html = renderEmail({
      heading: "Hello",
      intro: "Reminder",
      rows: [["Patient", 'Ann <b>"O\'Brien"</b> & Co']],
    });

    expect(html).not.toContain("<b>");
    expect(html).toContain("&lt;b&gt;");
    expect(html).toContain("&amp; Co");
    expect(html).toContain("&quot;O&#39;Brien&quot;");
  });

  it("uses the intro as the hidden preheader unless one is given", () => {
    const fromIntro = renderEmail({ heading: "H", intro: "Preview me" });
    expect(fromIntro).toContain("Preview me");

    const explicit = renderEmail({ heading: "H", intro: "Body", preheader: "Inbox line" });
    expect(explicit.indexOf("Inbox line")).toBeLessThan(explicit.indexOf("Body"));
  });

  it("stays client-safe: tables and inline styles only, no flex, grid or external assets", () => {
    const html = renderEmail({
      heading: "H",
      intro: "I",
      rows: [["A", "B"]],
      cta: { label: "Go", url: "https://example.com" },
    });

    expect(html).not.toMatch(/display:\s*(flex|grid)/);
    expect(html).not.toContain("<img");
    expect(html).not.toContain("<link");
    expect(html).not.toContain("<script");
    expect(html).toContain("<table");
  });

  it("omits the details block and button when none are supplied", () => {
    const html = renderEmail({ heading: "H", intro: "I" });
    expect(html).not.toContain("href=");
    expect(html).not.toContain("<tbody");
  });
});

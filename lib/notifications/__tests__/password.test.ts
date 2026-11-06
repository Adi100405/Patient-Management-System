import { describe, expect, it } from "vitest";
import { resetPasswordUrl } from "@/lib/notifications/links";
import { passwordChanged, passwordResetRequest } from "@/lib/notifications/templates";
import { createResetToken, RESET_TOKEN_TTL_MINUTES } from "@/lib/password";

/**
 * The password emails are account-security messages, not appointment updates,
 * so their contract is about trust, not scheduling: the link is the
 * credential (and nothing else renders or leaks it), the request email
 * reassures rather than accuses, the confirmation email is the tamper alarm,
 * and neither pretends to be about an appointment.
 */
describe("password-reset templates", () => {
  const resetUrl = resetPasswordUrl(createResetToken());

  const request = passwordResetRequest({ resetUrl, expiryMinutes: RESET_TOKEN_TTL_MINUTES });
  const changed = passwordChanged();

  describe("passwordResetRequest", () => {
    it("carries the reset link as the credential in every body, uncorrupted", () => {
      expect(resetUrl).toContain("/reset-password?token=");
      expect(request.text).toContain(resetUrl);
      expect(request.html).toContain(resetUrl);
      // base64url survives the layout's html-escaping.
      expect(request.html).toContain('href="' + resetUrl + '"');
    });

    it("never leaks the credential into the subject line", () => {
      const token = new URL(resetUrl).searchParams.get("token") ?? "";
      expect(token).not.toBe("");
      expect(request.subject).not.toContain(token);
    });

    it("states the lifetime and the one-time rule", () => {
      expect(request.text).toContain(`${RESET_TOKEN_TTL_MINUTES} minutes`);
      expect(request.text).toContain("works once");
      expect(request.html).toContain(`${RESET_TOKEN_TTL_MINUTES} minutes`);
    });

    it("reassures rather than accuses when the request was not made", () => {
      expect(request.text).toContain("didn't request this");
      expect(request.text).toContain("your current password still works");
      expect(request.html).toContain("didn&#39;t request this");
    });
  });

  describe("passwordChanged", () => {
    it("is the tamper alarm: nothing to click, no link to follow", () => {
      expect(changed.html).not.toContain("href=");
      expect(changed.text).not.toContain("http");
    });

    it("says the change happened, both visible ways", () => {
      expect(changed.subject).toContain("was changed");
      expect(changed.text).toContain("was just changed");
      expect(changed.html).toContain("was just changed");
    });

    it("tells the account holder what has already been enforced", () => {
      expect(changed.text).toContain("signed out");
      expect(changed.text).toContain("no longer works");
    });

    it("gives the not-this-was-me reader a next step", () => {
      expect(changed.text).toContain("contact support");
      expect(changed.html).toContain("contact support");
    });
  });

  describe("both emails", () => {
    it("ride the same branded shell as every other patient email", () => {
      expect(request.html.startsWith("<!doctype html>")).toBe(true);
      expect(changed.html.startsWith("<!doctype html>")).toBe(true);
    });

    it("speak about the account, never about an appointment", () => {
      for (const content of [request, changed]) {
        expect(content.html).not.toContain("Medrella appointment");
        expect(content.html).toContain("Medrella account");
        expect(content.text).not.toContain("appointment");
      }
    });

    it("exist only as email — no phone variant to consent against", () => {
      expect(request.sms).toBeUndefined();
      expect(request.whatsapp).toBeUndefined();
      expect(changed.sms).toBeUndefined();
      expect(changed.whatsapp).toBeUndefined();
    });
  });
});

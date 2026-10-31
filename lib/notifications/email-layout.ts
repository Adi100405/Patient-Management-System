/**
 * The shell every patient email is rendered into: teal letterhead, a white
 * card with the heading and body, a details grid, an optional call to action
 * and a footer. Templates supply content, never markup, so the wording can
 * change without anyone having to reason about table nesting.
 *
 * Email clients are the constraint here, not taste. Outlook still uses the
 * Word rendering engine, so the layout is table-based with inline styles, no
 * flex or grid, a fixed 600px measure, and no external images or web fonts -
 * a text wordmark renders everywhere, including clients that block images.
 */

export type EmailDetailRow = readonly [label: string, value: string];

export type EmailCta = { readonly label: string; readonly url: string };

export type EmailContent = {
  /** Heading inside the card, e.g. "Your appointment is booked". */
  readonly heading: string;
  /** Body paragraph; also the default inbox preview line. */
  readonly intro: string;
  /** Hidden preview line shown in the inbox list instead of the intro. */
  readonly preheader?: string;
  /** Label/value pairs rendered as a bordered details table. */
  readonly rows?: readonly EmailDetailRow[];
  readonly cta?: EmailCta;
  /** Small print under the body, e.g. how to reschedule. */
  readonly footnote?: string;
};

// The app's own palette (app/globals.css). Email cannot read CSS variables, so
// the handful of values it needs are repeated here as hex.
const TEAL = "#0f766e";
const INK_900 = "#211d18";
const INK_700 = "#4b4339";
const INK_500 = "#7a7164";
const CREAM_50 = "#fbf9f5";
const CREAM_100 = "#f4efe7";
const CREAM_200 = "#e9e2d6";

const FONT_STACK =
  "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function detailsTable(rows: readonly EmailDetailRow[]): string {
  const cells = rows
    .map(([label, value], index) => {
      const border = index === rows.length - 1 ? "none" : `1px solid ${CREAM_100}`;
      const labelCell = `padding:9px 0;border-bottom:${border};font-size:13px;color:${INK_500};vertical-align:top;`;
      const valueCell = `padding:9px 0;border-bottom:${border};font-size:14px;font-weight:600;color:${INK_900};text-align:right;vertical-align:top;`;
      return `<tr>
              <td style="${labelCell}">${escapeHtml(label)}</td>
              <td style="${valueCell}">${escapeHtml(value)}</td>
            </tr>`;
    })
    .join("\n            ");

  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;margin:20px 0 4px;">
            ${cells}
          </table>`;
}

function ctaButton(cta: EmailCta): string {
  return `<table role="presentation" cellpadding="0" cellspacing="0" style="margin-top:22px;">
              <tr>
                <td align="center" bgcolor="${TEAL}" style="border-radius:10px;">
                  <a href="${escapeHtml(cta.url)}" style="display:inline-block;padding:12px 22px;font-size:14px;font-weight:600;color:#ffffff;text-decoration:none;border-radius:10px;">${escapeHtml(cta.label)}</a>
                </td>
              </tr>
            </table>`;
}

export function renderEmail(content: EmailContent): string {
  const preheader = escapeHtml(content.preheader ?? content.intro);
  const heading = escapeHtml(content.heading);
  const intro = escapeHtml(content.intro);

  const details = content.rows && content.rows.length > 0 ? detailsTable(content.rows) : "";
  const button = content.cta ? ctaButton(content.cta) : "";
  const footnote = content.footnote
    ? `<p style="margin:22px 0 0;padding-top:16px;border-top:1px solid ${CREAM_100};font-size:12px;line-height:1.6;color:${INK_500};">${escapeHtml(content.footnote)}</p>`
    : "";

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${heading}</title>
</head>
<body style="margin:0;padding:0;background-color:${CREAM_100};font-family:${FONT_STACK};">
  <span style="display:none!important;visibility:hidden;opacity:0;height:0;width:0;overflow:hidden;mso-hide:all;">${preheader}</span>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:${CREAM_100};">
    <tr>
      <td align="center" style="padding:24px 12px;">
        <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="width:600px;max-width:600px;background-color:#ffffff;border:1px solid ${CREAM_200};border-radius:16px;overflow:hidden;">
          <tr>
            <td style="background-color:${TEAL};padding:20px 28px;">
              <span style="font-size:18px;font-weight:700;letter-spacing:-0.01em;color:#ffffff;">Medrella</span>
              <span style="font-size:12px;color:#ccfbf1;">&nbsp;&middot;&nbsp;Appointment update</span>
            </td>
          </tr>
          <tr>
            <td style="padding:28px;font-family:${FONT_STACK};">
              <h1 style="margin:0;font-size:20px;line-height:1.35;font-weight:600;color:${INK_900};">${heading}</h1>
              <p style="margin:12px 0 0;font-size:14px;line-height:1.65;color:${INK_700};">${intro}</p>
              ${details}
              ${button}
              ${footnote}
            </td>
          </tr>
          <tr>
            <td style="background-color:${CREAM_50};border-top:1px solid ${CREAM_200};padding:16px 28px;font-size:11px;line-height:1.6;color:${INK_500};">
              This is an automated message about your Medrella appointment. Please do not reply to it.
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

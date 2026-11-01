# Medrella Design System

> Extracted from the existing warm ivory + teal system (`app/globals.css`, `components/ui/*`).
> This is the contract for all UI work: every color, size and spacing value traces back to a token here.
> The signature is **quiet care**: ivory paper, warm ink, one teal accent, hairline borders, and motion that only ever confirms an action.

## 1. Atmosphere & Identity

A calm clinic desk, not a cold admin console. The surface is warm paper (`cream-50`) with warm brown-black ink; a single teal accent marks anything interactive or clinical. Depth comes from a hairline border plus a barely-there *warm-tinted* shadow — never a hard drop shadow or a cold grey. Everything is soft-cornered (`rounded-2xl` on surfaces, `rounded-xl` on controls) and generously spaced, so the product reads as unhurried and trustworthy. Colour is used to mean something: teal = action/care, rose = destructive, amber = needs attention, sky = done.

## 2. Color

### Palette (`app/globals.css` `@theme`)

| Role | Token | Value | Usage |
|------|-------|-------|-------|
| Surface / page | `--color-cream-50` | `#fbf9f5` | App background |
| Surface / raised | `--color-cream-100` | `#f4efe7` | Inset chips, hover fills |
| Border / default | `--color-cream-200` | `#e9e2d6` | Card + divider borders |
| Border / strong | `--color-cream-300` | `#d9d0c1` | Input borders, dashed empties |
| Text / primary | `--color-ink-900` | `#211d18` | Headings, values |
| Text / strong | `--color-ink-800` | `#322c25` | Emphasis body |
| Text / body | `--color-ink-700` | `#4b4339` | Default body |
| Text / secondary | `--color-ink-600` | `#645b4f` | Supporting copy |
| Text / muted | `--color-ink-500` | `#7a7164` | Captions, meta |
| Accent / surface | `--color-teal-50` | `#f0fffe` | Accent chips, selected fills |
| Accent / border | `--color-teal-200` | `#8ef6ed` | Accent chip rings |
| Accent / strong | `--color-teal-700` | `#057f75` | Buttons, links, focus ring (4.88:1 on white) |
| Accent / hover | `--color-teal-800` | `#066058` | Button hover |
| Accent / deep | `--color-teal-900` | `#064b46` | Gradients |

**Status colors** (Tailwind defaults, used semantically — no new hex allowed):

| Role | Classes | Meaning |
|------|---------|---------|
| Destructive / error | `rose-50/200/600/700` | Cancel, failed payment, refund issue |
| Warning / pending | `amber-50/200/700/800` | Awaiting payment, no-show |
| Success / done | `sky-50/200/700` | Completed visit; teal is reserved for *action* |

### Rules
- Accent (teal) is only for interactive or clinical-meaningful elements — never decoration.
- No raw hex outside `globals.css` / `email-layout.ts` (email cannot read CSS vars).
- Warm hue only; never introduce a cool grey. Status palettes are the sole exception, and only via the roles above.

## 3. Typography

### Scale (Tailwind sizes in use)

| Level | Class | Weight | Tracking | Usage |
|-------|-------|--------|----------|-------|
| Display | `text-5xl` / `text-4xl` | 700 | `tracking-tight` | Landing hero |
| H1 | `text-2xl` | 600 | `tracking-tight` | Page title |
| H2 | `text-2xl` | 600 | `tracking-tight` | Section heading |
| H3 | `text-base` | 600 | 0 | Card title |
| Body / lg | `text-lg` | 400 | 0 | Lead paragraph |
| Body | `text-sm` / `text-base` | 400/500 | 0 | Default text |
| Caption | `text-xs` | 500 | 0 | Timestamps, hints |
| Overline | `text-[11px] uppercase tracking-wide` | 500 | wide | KPI labels |

### Font Stack
- Primary: `Geist` → `var(--font-geist-sans)`, `ui-sans-serif, system-ui, sans-serif`
- Mono: `Geist Mono` → `var(--font-geist-mono)` (numeric/technical only)

### Rules
- Max two families. Body never below `text-sm` (14px).
- Data and counts use `tabular-nums`. Headings that wrap get `text-wrap: balance`.

## 4. Spacing & Layout

### Base Unit
4px (Tailwind default scale). Component spacing uses `gap-2/3/4`, padding `p-4/5`, section rhythm `space-y-6`, page blocks `space-y-16`.

| Token | Value | Usage |
|-------|-------|-------|
| `space-1.5` | 6px | Icon-to-label |
| `space-3` | 12px | Row internal gaps |
| `space-4` | 16px | Card padding on rows |
| `space-5` | 20px | Card padding |
| `space-6` | 24px | Between cards |
| `space-16` | 64px | Between page sections |

### Grid
- Max content width: `max-w-6xl` (72rem), `px-4` gutters.
- Breakpoints: `sm` 640, `md` 768, `lg` 1024.
- KPI strips: 2 cols → 3/4/5 cols at `sm`/`lg`, divided with `divide-cream-200`.

## 5. Components

### Card
- **Structure**: `div` (surface) → `CardHeader` / `CardContent` / `CardFooter`
- **Variants**: default; `interactive` (hover lift, for cards that are links)
- **Spacing**: header `p-5`, content `p-5 pt-0`
- **States**: rest (hairline border + `shadow-subtle`); interactive also hover (`border-teal-300`, `shadow-lift`, `-translate-y-0.5`)
- **Depth**: see Section 7
- **Layout**: stack

### Button
- **Variants**: `default` (teal), `outline`, `ghost`, `danger`, `subtle`; sizes `sm` / `default` / `lg` / `icon`
- **States**: hover (bg shift), **active (`scale-[0.98]`)**, focus-visible (ring `teal-600`), disabled, **loading** (inline spinner + disabled)
- **Accessibility**: real `<button>`; `aria-busy` when loading
- **Motion**: micro 120ms on `transform` + colors

### Badge
- **Variants**: `default`, `booked`, `cancelled`, `completed`, `no_show`, `outline`; pill, `ring-1 ring-inset`

### Form controls (Input / Textarea / Label)
- `rounded-xl`, `border-cream-300`, focus ring `teal-600`; label `text-sm text-ink-700`

### Dialog (confirm)
- **Structure**: fixed backdrop (`z-50`) → centered card (`rounded-2xl`) with title, description, actions
- **States**: enter (fade + `scale-95 → 100`), exit
- **Accessibility**: `role="dialog"` `aria-modal`, labelled by title, Esc closes, backdrop click closes, focus moves to the panel on open and returns to the trigger on close, body scroll locked
- **Motion**: standard 200ms, transform + opacity only

### Toast
- **Structure**: fixed region (bottom-right desktop, bottom-center mobile), stacked cards
- **Variants**: `success` (teal check), `error` (rose)
- **States**: enter (slide + fade from below), auto-dismiss ~5s, manual dismiss
- **Accessibility**: `role="status"` for success, `role="alert"` for error; never the only signal for a failed write

### CancelAppointment
- **Structure**: `Button` trigger → `Dialog` naming the appointment and the refund consequence → confirm calls the existing server action
- **States**: idle, confirming (spinner), success (toast + row updates via revalidation)
- **Rules**: the dialog states the policy outcome *before* cancelling; it never promises money is returned before the gateway accepts the refund

### BookingPanel
- **Structure**: client component — day tabs (`role="tablist"`) → slot grid → reason + confirm form
- **States**: day hover/selected, slot hover/selected (`Check` icon, `aria-pressed`), booking (spinner), booked / awaiting payment
- **Rules**: every day and free slot ships in the server payload; switching days is client state (no navigation, no round trip). The URL is kept shareable with `replaceState`, and the server action still re-validates the slot on submit.

### StatStrip
- Row of KPI cells: icon tile (`bg-cream-100`, `rounded-xl`) + overline label + `text-xl tabular-nums` value; tone by meaning

## 6. Motion & Interaction

### Timing

| Type | Duration | Easing | Usage |
|------|----------|--------|-------|
| Micro | 120ms | ease-out | Button press/active, icon color |
| Standard | 200ms | ease-in-out | Dialog open/close, toast enter, card hover lift |
| Emphasis | 400ms | `cubic-bezier(0.16,1,0.3,1)` | Reserved — not yet used |

### Rules
- Only animate `transform` and `opacity` (GPU-composited). Never `width`/`height`/`top`/`left`.
- Every interactive element has hover + active + focus-visible.
- Motion only ever confirms a state change — no decorative animation.
- `prefers-reduced-motion: reduce` collapses durations to ~0 (`app/globals.css`), and the Toast/Dialog must remain fully usable without motion.

## 7. Depth & Surface

**Strategy: mixed — tonal cream surfaces + hairline borders + tinted shadow for overlays only.**

| Level | Value | Usage |
|-------|-------|-------|
| Subtle | `0 1px 2px rgba(33,29,24,0.04)` | Cards at rest |
| Lift | `0 10px 30px -12px rgba(33,29,24,0.18)` | Interactive card hover |
| Overlay | `0 24px 48px -24px rgba(33,29,24,0.35)` | Dialog / toast |
| Focus | `0 0 0 2px rgba(5,127,117,0.35)` | Focus aura (optional, in addition to outline) |

Shadows are **warm-tinted** (ink hue), never pure black. Elevation is only for things that float above the page — cards at rest are flat hairline surfaces.

## 8. Accessibility Constraints & Accepted Debt

### Constraints
- Target **WCAG 2.2 AA**. Contrast floor **4.5:1** body / **3:1** large text (teal-700 on white = 4.88:1).
- Visible focus ring on every interactive element (`:focus-visible`, `outline: 2px solid #057f75`).
- Full keyboard reachability; dialogs trap focus, Esc closes, and return focus to the trigger.
- `prefers-reduced-motion` respected globally; toasts/dialogs usable with motion disabled.
- Both dashboards reflow to one column at 375px with no horizontal scroll of primary content.

### Accepted Debt

| Item | Location | Why accepted | Owner / Exit |
|------|----------|--------------|--------------|
| Icons are Lucide (a dependency already present) rather than a differentiated set | `app/dashboard/*`, `components/*` | Lucide is already installed and consistent; adding Phosphor would add a dependency for no functional gain | Revisit only if a bespoke icon set is commissioned |
| Status colors use Tailwind defaults (rose/amber/sky) outside `@theme` | dashboards, badges | They are semantic roles, not brand colors; tokenising them adds no clarity | Fold into `@theme` if a status hue ever changes |
| No dark mode | app-wide | The brief specifies a single warm light theme | Out of scope by product decision |
| Email HTML uses raw hex | `lib/notifications/email-layout.ts` | Email clients cannot read CSS variables | Mirror any token change by hand |

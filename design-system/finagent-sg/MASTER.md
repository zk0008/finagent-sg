# Design System Master File — FinAgent-SG

> **LOGIC:** When building a specific page, first check `design-system/finagent-sg/pages/[page-name].md`.
> If that file exists, its rules **override** this Master file.
> If not, strictly follow the rules below.

---

**Project:** FinAgent-SG
**Version:** 1.0
**Date:** 2026-06-22
**Category:** B2B SaaS — Accounting / Finance (Singapore SME)
**Visual Reference:** Linear (linear.app) application UI — not their marketing site
**Mode:** Light only (dark mode deferred)

---

## Design Philosophy

Minimal, warm neutral, stable, corporate-scale trustworthy. This is a financial product — users need to feel their data is in safe, competent hands. UI chrome is invisible; data is the hero. Nothing feels decorative. Spacing is intentional and tight. The palette is warm rather than cold — avoiding the sterile grey of generic enterprise software without crossing into "startup playful".

---

## Colour Palette

### Core Tokens

| Role | Hex | Tailwind Custom Token | Notes |
|------|-----|-----------------------|-------|
| **Background** | `#FAF9F6` | `bg-canvas` | Warm cream — page root background |
| **Surface** | `#F5F3EE` | `bg-surface` | Card / panel background, slightly warmer |
| **Surface raised** | `#EFECE6` | `bg-surface-raised` | Hover tint, alternating table rows |
| **Text primary** | `#1C1917` | `text-primary` | Near-black warm charcoal |
| **Text secondary** | `#6B6560` | `text-secondary` | Labels, metadata, secondary copy |
| **Text muted** | `#9B9490` | `text-muted` | Placeholder text, disabled, captions |
| **Border** | `#E5E1DA` | `border-default` | Default 1px borders everywhere |
| **Border strong** | `#C8C2B8` | `border-strong` | Hover/focus borders, dividers |
| **Primary** | `#3D6B52` | `text-accent` / `bg-accent` | Muted sage green — primary CTA, links, active states |
| **Primary hover** | `#325744` | `bg-accent-hover` | Darker on hover |
| **Primary subtle** | `#EAF1EC` | `bg-accent-subtle` | Light green tint for badges, chips |
| **Secondary accent** | `#B5841A` | `text-amber` / `bg-amber` | Warm amber — highlights, gold status, warnings |
| **Secondary subtle** | `#FBF3DE` | `bg-amber-subtle` | Amber tint for warning badges |
| **Error** | `#9B3A3A` | `text-error` / `bg-error` | Muted warm red |
| **Error subtle** | `#F8EDEC` | `bg-error-subtle` | Error tint for inline alerts |
| **Success** | `#3D6B52` | `text-success` | Same as primary sage green |
| **Success subtle** | `#EAF1EC` | `bg-success-subtle` | Same as primary subtle |

### Colour Rules

- **NO** bright saturated colours. **NO** gradients of any kind. **NO** shadows heavier than `0 1px 2px`.
- Pure white (`#FFFFFF`) is acceptable only inside modals/dialogs and input fields to create contrast against the warm canvas.
- The sage green (`#3D6B52`) is the single primary accent. Use it sparingly — CTAs, active nav states, selected rows, focus rings.
- Amber (`#B5841A`) is secondary-only: status chips, warning banners, highlight callouts. Never as a button colour.
- Do not use blues, purples, teals, or any cool-toned accent — they conflict with the warm palette.

---

## Typography

### Fonts

| Role | Font | Load Method |
|------|------|-------------|
| **Primary (UI)** | Inter | `next/font/google` — already in project |
| **Monospace (figures)** | JetBrains Mono | `next/font/google` — add alongside Inter |

All financial figures (currency amounts, percentages, account numbers) must use JetBrains Mono. This distinguishes data from UI copy and improves scannability in tables.

### Scale

| Token | Size | Weight | Line Height | Usage |
|-------|------|--------|-------------|-------|
| `text-page-title` | 22px / 1.375rem | 600 | 1.3 | Page `<h1>` — restrained |
| `text-section-heading` | 16px / 1rem | 600 | 1.4 | Section headers, card titles |
| `text-body` | 14px / 0.875rem | 400 | 1.5 | Default body copy |
| `text-body-medium` | 14px / 0.875rem | 500 | 1.5 | Emphasised body, table headings |
| `text-small` | 12px / 0.75rem | 400 | 1.5 | Metadata, timestamps, captions |
| `text-small-medium` | 12px / 0.75rem | 500 | 1.5 | Labels, badges, nav items |
| `text-figure` | 14px / 0.875rem | 400 | 1.5 | Financial values (JetBrains Mono) |
| `text-figure-lg` | 18px / 1.125rem | 500 | 1.3 | Summary totals (JetBrains Mono) |

**Rules:**
- Page titles max 24px. No heading above 24px in the application.
- No `font-bold` (700) anywhere — use `font-semibold` (600) for emphasis.
- No `font-light` (300) or `font-thin` — 400 is the floor weight.
- Body text is 14px, not 16px. This is an information-dense financial application, not a marketing page.

---

## Spacing

Tight, intentional. Nothing feels loose or padded. Follow an 4px base grid.

| Token | Value | Tailwind Class | Usage |
|-------|-------|----------------|-------|
| `space-1` | 4px | `p-1` / `gap-1` | Icon gaps, badge padding |
| `space-2` | 8px | `p-2` / `gap-2` | Inline element spacing |
| `space-3` | 12px | `p-3` / `gap-3` | Button padding (vertical), compact list items |
| `space-4` | 16px | `p-4` / `gap-4` | Card padding, standard gaps |
| `space-6` | 24px | `p-6` / `gap-6` | Section spacing, modal padding |
| `space-8` | 32px | `p-8` / `gap-8` | Large section margins |
| `space-12` | 48px | `p-12` / `gap-12` | Page top padding |

---

## Elevation & Shadow

Shadows are near-absent. Containment is achieved via 1px borders, not depth.

| Level | Value | Usage |
|-------|-------|-------|
| `shadow-none` | `none` | Default for all cards and panels |
| `shadow-xs` | `0 1px 2px rgba(28, 25, 23, 0.04)` | Subtle lift — buttons on hover only |
| `shadow-sm` | `0 1px 3px rgba(28, 25, 23, 0.06), 0 1px 2px rgba(28, 25, 23, 0.04)` | Dropdowns, popover menus |
| `shadow-modal` | `0 4px 16px rgba(28, 25, 23, 0.10)` | Modals / dialogs only |

**Rule:** Never use `shadow-md`, `shadow-lg`, or heavier. If something needs to feel elevated, use a border + `bg-surface-raised` background, not a shadow.

---

## Border Radius

| Token | Value | Tailwind Class | Usage |
|-------|-------|----------------|-------|
| `radius-sm` | 4px | `rounded` | Badges, chips, small tags |
| `radius-md` | 6px | `rounded-md` | Buttons, inputs, cards |
| `radius-lg` | 8px | `rounded-lg` | Modals, panels, sidebars |

**Rule:** Never use `rounded-full` (pill shapes). Never exceed 8px for application components. Use `rounded-md` as the default for all interactive elements.

---

## Component Specifications

### Buttons

Three variants only. All use `rounded-md` (6px). All use `transition-colors duration-150`.

```css
/* Primary — solid fill sage green */
.btn-primary {
  background-color: #3D6B52;
  color: #FFFFFF;
  padding: 8px 14px;           /* py-2 px-3.5 */
  border-radius: 6px;
  font-size: 14px;
  font-weight: 500;
  border: 1px solid #3D6B52;
  transition: background-color 150ms ease, border-color 150ms ease;
  cursor: pointer;
  height: 36px;
}

.btn-primary:hover {
  background-color: #325744;
  border-color: #325744;
}

.btn-primary:focus-visible {
  outline: 2px solid #3D6B52;
  outline-offset: 2px;
}

/* Secondary — outline */
.btn-secondary {
  background-color: transparent;
  color: #1C1917;
  padding: 8px 14px;
  border-radius: 6px;
  font-size: 14px;
  font-weight: 500;
  border: 1px solid #E5E1DA;
  transition: background-color 150ms ease, border-color 150ms ease;
  cursor: pointer;
  height: 36px;
}

.btn-secondary:hover {
  background-color: #F5F3EE;
  border-color: #C8C2B8;
}

/* Ghost — no border, no background */
.btn-ghost {
  background-color: transparent;
  color: #6B6560;
  padding: 8px 14px;
  border-radius: 6px;
  font-size: 14px;
  font-weight: 400;
  border: 1px solid transparent;
  transition: background-color 150ms ease, color 150ms ease;
  cursor: pointer;
  height: 36px;
}

.btn-ghost:hover {
  background-color: #EFECE6;
  color: #1C1917;
}
```

**Button sizes:** One standard size only (36px height). For compact contexts use 32px height with `padding: 6px 12px`.

**States:** Loading state must show a spinner and disable pointer events. Disabled state: `opacity: 0.45`, `cursor: not-allowed`.

### Cards / Panels

```css
.card {
  background-color: #F5F3EE;   /* bg-surface */
  border: 1px solid #E5E1DA;  /* border-default */
  border-radius: 8px;          /* rounded-lg */
  padding: 16px;               /* p-4 */
  /* NO box-shadow by default */
}

/* Flat card on canvas — border only, no shadow */
.card-flat {
  background-color: #FFFFFF;
  border: 1px solid #E5E1DA;
  border-radius: 6px;
  padding: 16px;
}
```

Cards do not have hover states unless they are interactive/clickable. Clickable cards get:
```css
.card-clickable:hover {
  background-color: #EFECE6;
  border-color: #C8C2B8;
  transition: background-color 150ms ease, border-color 150ms ease;
  cursor: pointer;
}
```

### Form Inputs

```css
.input {
  background-color: #FFFFFF;
  border: 1px solid #E5E1DA;
  border-radius: 6px;
  padding: 8px 12px;
  font-size: 14px;
  color: #1C1917;
  width: 100%;
  height: 36px;
  transition: border-color 150ms ease;
  /* NO inner box-shadow (no inset shadow) */
}

.input::placeholder {
  color: #9B9490;
}

.input:hover {
  border-color: #C8C2B8;
}

.input:focus {
  border-color: #3D6B52;
  outline: none;
  box-shadow: 0 0 0 2px rgba(61, 107, 82, 0.12); /* subtle green ring */
}

.input:disabled {
  background-color: #F5F3EE;
  color: #9B9490;
  cursor: not-allowed;
}

/* Error state */
.input-error {
  border-color: #9B3A3A;
}

.input-error:focus {
  box-shadow: 0 0 0 2px rgba(155, 58, 58, 0.12);
}
```

Labels: 12px, font-weight 500, colour `#6B6560`, margin-bottom 4px. Always use `<label for="">`.

### Tables

Financial data tables. Clean, scannable, no decorative chrome.

```css
.table {
  width: 100%;
  border-collapse: collapse;
  font-size: 14px;
  color: #1C1917;
}

.table thead th {
  font-size: 12px;
  font-weight: 500;
  color: #6B6560;
  text-align: left;
  padding: 8px 12px;
  border-bottom: 1px solid #E5E1DA;
  white-space: nowrap;
}

/* Numbers right-aligned in thead */
.table thead th.numeric {
  text-align: right;
}

.table tbody td {
  padding: 10px 12px;
  border-bottom: 1px solid #F5F3EE;  /* very subtle row separator */
}

/* Alternating row tint — very subtle */
.table tbody tr:nth-child(even) {
  background-color: #FAF9F6;
}

.table tbody tr:hover {
  background-color: #EFECE6;
}

/* Financial figures in JetBrains Mono, right-aligned */
.table tbody td.numeric {
  font-family: 'JetBrains Mono', monospace;
  text-align: right;
  font-size: 13px;
}

/* Total row */
.table tfoot td {
  font-weight: 600;
  border-top: 1px solid #C8C2B8;
  padding: 10px 12px;
  font-family: 'JetBrains Mono', monospace;
  text-align: right;
}
```

### Sidebar Navigation

```css
.sidebar {
  background-color: #F5F3EE;
  border-right: 1px solid #E5E1DA;
  width: 220px;
  padding: 12px 8px;
}

.nav-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 7px 10px;
  border-radius: 6px;
  font-size: 14px;
  font-weight: 400;
  color: #6B6560;
  cursor: pointer;
  transition: background-color 150ms ease, color 150ms ease;
  text-decoration: none;
}

.nav-item:hover {
  background-color: #EFECE6;
  color: #1C1917;
}

/* Active state — subtle background tint, NOT bold colour */
.nav-item.active {
  background-color: #EAF1EC;  /* bg-accent-subtle */
  color: #3D6B52;             /* accent */
  font-weight: 500;
}

.nav-item .icon {
  width: 16px;
  height: 16px;
  stroke-width: 1.5;  /* thin monoline, Lucide default */
  flex-shrink: 0;
}
```

### Badges / Status Chips

```css
.badge {
  display: inline-flex;
  align-items: center;
  padding: 2px 8px;
  border-radius: 4px;
  font-size: 12px;
  font-weight: 500;
  white-space: nowrap;
}

.badge-success  { background: #EAF1EC; color: #3D6B52; }
.badge-warning  { background: #FBF3DE; color: #B5841A; }
.badge-error    { background: #F8EDEC; color: #9B3A3A; }
.badge-neutral  { background: #EFECE6; color: #6B6560; }
```

### Modals / Dialogs

```css
.modal-overlay {
  background: rgba(28, 25, 23, 0.40);
  /* NO backdrop-filter blur — too decorative */
}

.modal {
  background: #FFFFFF;
  border: 1px solid #E5E1DA;
  border-radius: 8px;
  padding: 24px;
  box-shadow: 0 4px 16px rgba(28, 25, 23, 0.10);
  max-width: 520px;
  width: 90%;
}

.modal-header {
  font-size: 16px;
  font-weight: 600;
  color: #1C1917;
  margin-bottom: 16px;
}
```

---

## Transitions

All transitions: **150–200ms**, `ease` or `ease-in-out`. Never decorative.

| Context | Duration | Property |
|---------|----------|----------|
| Button states | 150ms | `background-color`, `border-color`, `color` |
| Nav hover | 150ms | `background-color`, `color` |
| Input focus | 150ms | `border-color`, `box-shadow` |
| Card hover | 150ms | `background-color`, `border-color` |
| Modal open | 200ms | `opacity`, `transform` (translateY 4px → 0) |
| Dropdown open | 150ms | `opacity` only |

No `transform: translateY(-2px)` on card hover (layout shift). No `transform: scale()`. No spring animations.

---

## Icons

Lucide React exclusively. Already in project.

- **Stroke width:** 1.5 (Lucide default) — never increase to 2+ (too heavy)
- **Standard size:** `w-4 h-4` (16px) for inline/nav icons, `w-5 h-5` (20px) for page-level actions
- **Colour:** Inherit from parent text colour — do not hard-code icon colours
- Never use emoji as icons

---

## Page Layout

```
┌─────────────────────────────────────────────────────┐
│ Top bar (48px) — logo, workspace name, user avatar  │
│ border-bottom: 1px solid #E5E1DA                    │
├────────────┬────────────────────────────────────────┤
│ Sidebar    │ Page content                           │
│ 220px      │ padding: 24px                          │
│ bg-surface │ max-width: 1280px                      │
│            │ background: #FAF9F6 (canvas)           │
│            │                                        │
│            │  Page title (22px / semibold)          │
│            │  Subheading / breadcrumb (12px / muted)│
│            │  ─────────────────────────────────     │
│            │  Content area                          │
└────────────┴────────────────────────────────────────┘
```

- Top bar height: 48px (tight — not 64px)
- Sidebar width: 220px fixed
- Page content padding: 24px (not 32px)
- Content max-width: 1280px
- Section spacing between content blocks: 24px

---

## Tailwind CSS Configuration

Add to `tailwind.config.ts` under `theme.extend`:

```ts
colors: {
  canvas:       '#FAF9F6',
  surface:      '#F5F3EE',
  'surface-raised': '#EFECE6',
  border:       '#E5E1DA',
  'border-strong': '#C8C2B8',
  accent: {
    DEFAULT:    '#3D6B52',
    hover:      '#325744',
    subtle:     '#EAF1EC',
  },
  amber: {
    DEFAULT:    '#B5841A',
    subtle:     '#FBF3DE',
  },
  error: {
    DEFAULT:    '#9B3A3A',
    subtle:     '#F8EDEC',
  },
  'text-primary':   '#1C1917',
  'text-secondary': '#6B6560',
  'text-muted':     '#9B9490',
},
fontFamily: {
  sans: ['Inter', 'system-ui', 'sans-serif'],
  mono: ['JetBrains Mono', 'Consolas', 'monospace'],
},
fontSize: {
  '2xs': ['11px', { lineHeight: '1.5' }],
  xs:    ['12px', { lineHeight: '1.5' }],
  sm:    ['13px', { lineHeight: '1.5' }],
  base:  ['14px', { lineHeight: '1.5' }],
  md:    ['15px', { lineHeight: '1.4' }],
  lg:    ['16px', { lineHeight: '1.4' }],
  xl:    ['18px', { lineHeight: '1.3' }],
  '2xl': ['22px', { lineHeight: '1.3' }],
},
borderRadius: {
  sm:  '4px',
  md:  '6px',
  lg:  '8px',
  xl:  '10px',
  '2xl': '12px',
},
boxShadow: {
  xs:     '0 1px 2px rgba(28, 25, 23, 0.04)',
  sm:     '0 1px 3px rgba(28, 25, 23, 0.06), 0 1px 2px rgba(28, 25, 23, 0.04)',
  modal:  '0 4px 16px rgba(28, 25, 23, 0.10)',
  none:   'none',
},
```

---

## shadcn/ui Theme Overrides

In `globals.css`, override shadcn CSS variables to align with this design system:

```css
:root {
  --background:     250 249 246;   /* #FAF9F6 warm canvas */
  --foreground:     28 25 23;      /* #1C1917 */
  --card:           245 243 238;   /* #F5F3EE */
  --card-foreground: 28 25 23;
  --popover:        255 255 255;
  --popover-foreground: 28 25 23;
  --primary:        61 107 82;     /* #3D6B52 sage green */
  --primary-foreground: 255 255 255;
  --secondary:      239 236 230;   /* #EFECE6 */
  --secondary-foreground: 28 25 23;
  --muted:          239 236 230;
  --muted-foreground: 107 101 96;  /* #6B6560 */
  --accent:         234 241 236;   /* #EAF1EC */
  --accent-foreground: 61 107 82;
  --destructive:    155 58 58;     /* #9B3A3A */
  --destructive-foreground: 255 255 255;
  --border:         229 225 218;   /* #E5E1DA */
  --input:          229 225 218;
  --ring:           61 107 82;     /* sage green focus ring */
  --radius:         0.375rem;      /* 6px = rounded-md */
}
```

---

## Anti-Patterns — NEVER Do These

- **NO** glassmorphism (`backdrop-filter: blur`)
- **NO** gradients — `background: linear-gradient(...)` is forbidden
- **NO** neon or bright saturated accents
- **NO** shadows heavier than `shadow-modal` (max `0 4px 16px`)
- **NO** `rounded-full` on buttons or form elements
- **NO** pill-shaped buttons
- **NO** decorative illustrations or mascots
- **NO** AI purple / pink gradients
- **NO** dark mode components (light mode only — defer dark mode)
- **NO** emojis as icons — Lucide React only
- **NO** `font-bold` (700) — use `font-semibold` (600) max
- **NO** page titles above 24px
- **NO** `transform: scale()` on hover
- **NO** `transform: translateY(-2px)` on card hover
- **NO** inner box-shadows on inputs (`box-shadow: inset ...`)
- **NO** `border-2` (2px borders) — all borders are 1px
- **NO** blue, teal, purple, or cool-toned accents
- **NO** pure white (`#FFFFFF`) as page background — use `#FAF9F6`

---

## Pre-Delivery Checklist

Before delivering any UI code:

- [ ] Background is `#FAF9F6` (canvas), not pure white and not grey
- [ ] All text is warm charcoal, not cold grey
- [ ] Primary accent is sage green `#3D6B52`, nothing else
- [ ] No gradients anywhere
- [ ] No shadows heavier than 1px on cards (border-only containment)
- [ ] Buttons use `rounded-md` (6px), never `rounded-full`
- [ ] Financial figures use `font-mono` (JetBrains Mono), right-aligned
- [ ] All icons from Lucide React, stroke-width 1.5
- [ ] Transitions are 150ms, `background-color` / `border-color` / `color` only
- [ ] No emojis anywhere
- [ ] All clickable elements have `cursor-pointer`
- [ ] Focus states visible (sage green `outline: 2px solid #3D6B52`)
- [ ] Body font size 14px, not 16px
- [ ] Page title maximum 22–24px, font-weight 600
- [ ] Sidebar active state is subtle tint (`bg-accent-subtle`), not bold colour
- [ ] Responsive: 375px, 768px, 1024px, 1440px
- [ ] `prefers-reduced-motion` respected
- [ ] Text contrast meets WCAG AA (4.5:1 on warm canvas background)

# r-ui: Project DNA Adaptation & Flexibility Engine (v3.0.0)

An adaptive, **anti-rigid** system engineered to precisely tailor components to unique project requirements. Focused directly on **visual-first** presentation, free from wall-of-text copy, free from murky heavy shadows, free from neon/cyberpunk clichés, and **100% adaptive to existing project tokens and conventions**.

---

## 1. Visual Calibration: 4 Adaptive Dials

| Dial | Minimum Value (1) | Maximum Value (10) | Visual Impact |
|:---|:---|:---|:---|
| **1. DENSITY** | Spacious / Luxury (`p-8`, `gap-6`) | Dense / Cockpit (`p-2`, `gap-2`) | Sets information throughput per viewport |
| **2. RADIUS** | Sharp / Brutalist (`rounded-none`) | Soft / Pill (`rounded-full`) | Governs formality vs friendliness |
| **3. MOTION** | Static / Zero-Motion (`duration-0`) | Dynamic Springs (`cubic-bezier`) | Governs tactile responsiveness & micro-interactions |
| **4. CONTRAST** | Calm / Low-Contrast Editorial | Strict / High-Contrast WCAG AAA | Establishes visual hierarchy & boundary separation |

---

## 2. 5 Core Project Archetypes

| Project Archetype | Density | Radius | Motion | Visual Standards & Engineering Guide |
|:---|:---:|:---:|:---:|:---|
| **1. High-Density B2B Cockpit** *(Trading, ERP, CRM, Analytics)* | **8–9** | `4px` | **1–2** | Compact padding (`8-12px`), 13–14px body text, dense data grids, space efficiency without decorative clutter. |
| **2. Consumer Playful / Lifestyle** *(E-Commerce, Social, EdTech)* | **4–5** | `12-16px` | **7–8** | Generous whitespace (`24-32px`), cards with subtle micro-borders, tactile spring physics on touch. |
| **3. Minimalist Swiss / Editorial** *(Portfolio, Agency, Publishing)* | **3–4** | `0–2px` | **2–3** | Expansive negative space, crisp 1px borders, high-contrast display typography, elegant asymmetric layouts. |
| **4. Minimalist Precision Dark Tech** *(DevTools, AI Workbenches, Cloud)* | **7–8** | `4–6px` | **3–4** | Mature dark canvas (`#0b0f19`), crisp text (`#f9fafb`), 1px subtle borders, monospace tabular data, **zero-neon**. |
| **5. Regulated & Public Sector** *(Government, Healthcare, Legal)* | **5–6** | `6–8px` | **1–2** | High-contrast WCAG AAA, min 48px touch targets, zero-transparency, uncompromising legibility. |

---

## 3. The Universal Token Adaptation Doctrine (Greenfield vs Existing Systems)

`r-ui` enforces a **Context-Aware Token Architecture**. AI agents and engineers must never blindly force external naming schemes onto codebases that already have an established foundation.

```text
┌─────────────────────────────────────────────────────────────────────────────┐
│                   THE CONTEXT-AWARE TOKEN ADAPTATION RULE                   │
├─────────────────────────────────────────────────────────────────────────────┤
│  IF (Project has existing design system / tokens / CSS vars):               │
│     ──► ADAPT TO THE PROJECT. Do NOT force --r-ui-* onto the codebase.      │
│     ──► Map all component styling directly to project's native tokens.      │
│     ──► Reuse existing class conventions (Tailwind, CSS Modules, BEM, etc.). │
│                                                                             │
│  ELSE IF (Greenfield project OR no established design tokens):              │
│     ──► USE --r-ui-* as the clean, standard, IP-compliant foundation.       │
│     ──► Leverage the full 9-pillar token and theme suite out-of-the-box.    │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Key Principles:
1. **Never Force `--r-ui-*` on Existing Codebases**:
   If a codebase already defines `:root` variables like `--color-primary`, `--bg-app`, `--border`, or uses utility frameworks like Tailwind or Radix/Shadcn, you **MUST NOT** rename them, replace them, or force `--r-ui-*` variables into their established templates.
2. **First-Class Discovery & Token Mapping**:
   Before authoring or modifying components, scan the workspace for existing design tokens:
   - Check `globals.css`, `variables.css`, `tokens.css`, `:root {}` blocks.
   - Check framework config files: `tailwind.config.*`, `theme.ts`, `tokens.json`.
   - Discover theme attributes: `data-theme`, `.dark`, `class="dark"`.
3. **Transparent Drop-In Replacement**:
   `r-ui` components are architectural blueprints. Their visual quality, spring physics, layout harmony, and accessible anatomy remain identical whether bound to `--r-ui-*` or `--project-*` tokens.

---

## 4. Adapting to Established Design Systems (Concrete Mapping Scenarios)

### Scenario A: Shadcn / Radix / Next.js Projects
When the project uses Shadcn-style tokens (`--background`, `--foreground`, `--primary`, `--muted`, `--border`, `--radius`), `r-ui` components map directly to them:

```css
/* Adapting an r-ui Action Button directly to existing Shadcn tokens */
.my-project-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 8px 16px;
  min-height: 40px;
  font-family: inherit;
  font-size: 0.875rem;
  font-weight: 500;
  border-radius: var(--radius);
  background-color: hsl(var(--primary));
  color: hsl(var(--primary-foreground));
  border: 1px solid transparent;
  cursor: pointer;
  /* r-ui Spring Physics & Micro-Press */
  transition: transform 100ms cubic-bezier(0.16, 1, 0.3, 1),
              background-color 180ms ease;
}

.my-project-btn:active {
  transform: scale(0.975);
}

.my-project-btn:focus-visible {
  outline: none;
  box-shadow: 0 0 0 2px hsl(var(--background)), 0 0 0 4px hsl(var(--ring));
}
```

### Scenario B: Tailwind CSS Projects (v3 / v4)
When working in a Tailwind project, render components using Tailwind's native utility classes and configured `@theme` tokens:

```tsx
// Adapting an r-ui Metric Card directly using native Tailwind utilities
export function TelemetryCard({ label, value, change }: TelemetryCardProps) {
  return (
    <div className="bg-card text-card-foreground border border-border rounded-lg p-5 shadow-xs transition-all duration-150 hover:border-border/80 hover:-translate-y-0.5">
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium uppercase tracking-wider text-muted-foreground">{label}</span>
        <span className="inline-block w-2 h-2 rounded-full bg-emerald-500 animate-pulse" />
      </div>
      <div className="mt-3 text-2xl font-bold tracking-tight font-mono tabular-nums">{value}</div>
      <div className="mt-1 text-xs text-muted-foreground flex items-center gap-1.5">
        <span className="text-emerald-500 font-medium font-mono">{change}</span> vs last week
      </div>
    </div>
  );
}
```

### Scenario C: Custom Enterprise `:root` Systems
When an enterprise project already has its own bespoke token dictionary:

```css
/* Existing Project Tokens (DO NOT OVERWRITE OR RENAME) */
:root {
  --color-canvas-base: #0f172a;
  --color-panel-surface: #1e293b;
  --color-brand-blue: #3b82f6;
  --color-border-line: #334155;
  --color-text-title: #f8fafc;
  --color-text-sub: #94a3b8;
  --app-radius-default: 6px;
}

/* r-ui Component seamlessly consumes project tokens */
.app-card {
  background-color: var(--color-panel-surface);
  border: 1px solid var(--color-border-line);
  border-radius: var(--app-radius-default);
  padding: 16px;
  color: var(--color-text-title);
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.1);
  transition: transform 180ms cubic-bezier(0.16, 1, 0.3, 1),
              border-color 180ms ease;
}

.app-card:hover {
  border-color: var(--color-brand-blue);
  transform: translateY(-2px);
}
```

---

## 5. Greenfield Brand Token Override (When Using `--r-ui-*` as Foundation)

For greenfield projects where `--r-ui-*` is adopted as the primary design foundation, override tokens cleanly in a dedicated brand file:

```css
/* src/styles/project-brand-override.css */
:root {
  /* 1. Custom Brand Colors */
  --r-ui-color-accent-primary: #0284c7;
  --r-ui-color-accent-primary-hover: #0369a1;
  --r-ui-color-focus-ring: #0284c7;

  /* 2. Brand Typography */
  --font-family-display: 'Plus Jakarta Sans', system-ui, sans-serif;
  --font-family-body: system-ui, -apple-system, sans-serif;

  /* 3. Project Radius & Density */
  --r-ui-radius-sm: 4px;
  --r-ui-radius-md: 8px;
  --r-ui-radius-lg: 12px;
  --r-ui-space-4: 0.75rem; /* 12px for higher density */
}
```

---

## 6. Headless & Unstyled Mode (`unstyled?: boolean`)

When consumers need total freedom without CSS class collisions, pass `unstyled` to strip opinionated defaults:

```tsx
<Card unstyled className="bg-slate-900 border border-slate-800 rounded-xl p-6 hover:border-slate-700 transition-colors">
  <Card.Title className="text-xl font-bold text-slate-100">
    Precision Workbench Card
  </Card.Title>
  <Card.Body className="text-slate-400 mt-2 text-sm leading-relaxed">
    Components flex to adapt to your project's design system without rigidity.
  </Card.Body>
</Card>
```

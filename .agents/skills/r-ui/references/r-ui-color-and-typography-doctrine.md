# r-ui Color Science & Typographic Composition Master Specification (v2.4.0)

> **Namespace**: `--r-ui-*`  
> **Philosophy**: Zero-Slop, Zero-Neon, Anti-Monoculture, Mathematically Precise, WCAG 2.2 AAA Compliant.

---

## 🎨 PART 1: COLOR SCIENCE & PALETTE ARCHITECTURE

```text
+-----------------------------------------------------------------------------------------+
|                         THE 60-30-10 SPATIAL COLOR FORMULA                              |
+------------------------------------+--------------------------------+-------------------+
| 60% DOMINANT FOUNDATION             | 30% STRUCTURAL SECONDARY       | 10% FOCAL ACCENT  |
| Canvas, Surfaces, Cards, Dialogs   | Hairlines, Borders, Subtitles  | Primary CTA, Ring |
| Unified Neutral Undertone Family   | Table Headers, Neutral Badges  | Active Tab, Dot   |
+------------------------------------+--------------------------------+-------------------+
```

### 1.1. The 60-30-10 Spatial Color Distribution
World-class interfaces feel effortless because color is applied with surgical discipline rather than decorative scattering:
1. **60% Dominant Neutral Base**: Canvas backdrop (`--r-ui-color-canvas`), surface panels (`--r-ui-color-surface`), and elevated cards (`--r-ui-color-surface-elevated`). This foundation sets the visual temperature of the application.
2. **30% Structural Secondary Layer**: 1px subtle borders (`--r-ui-color-border-subtle`), standard dividers (`--r-ui-color-border-standard`), secondary body text (`--r-ui-color-text-secondary`), and hover state backdrops.
3. **10% Calibrated Focal Accent**: Reserved strictly for primary action buttons (`--r-ui-color-accent-primary`), focus rings (`--r-ui-color-focus-ring`), active selection pills, and critical status pulses. **When everything is highlighted, nothing is highlighted.**

---

### 1.2. The 4 Coherent Neutral Undertone Families

Never build on a sterile `#000000` or raw gray `#808080`. Always anchor the canvas in a coherent undertone family:

| Undertone Family | Hue & Saturation Range | Target Archetype | Canvas (Dark) | Surface (Dark) | Canvas (Light) |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **Cool Slate** | Hue 215°–225°, Sat 12–18% | DevOps, Cloud, Telemetry, Security | `#07090e` | `#0f1422` | `#f8fafc` |
| **Neutral Zinc** | Hue 240°, Sat 4–8% | Linear-style, Minimalist, SaaS Management | `#09090b` | `#141418` | `#fafafa` |
| **Warm Stone** | Hue 35°–45°, Sat 10–14% | Editorial, Luxury, Lifestyle, Docs | `#0f0e0c` | `#1c1917` | `#faf8f5` |
| **OLED Obsidian** | Hue 260°, Sat 2–4% (Vantablack) | Media Viewers, Creative Tools, AI Labs | `#040405` | `#0d0e12` | `#f4f4f5` |

> ⚠️ **Undertone Mixing Violation**: Never mix competing undertones in the same layout (e.g. placing a warm Stone card inside a cool Slate canvas). Undertone dissonance is an immediate tell of amateur AI design.

---

### 1.3. The 9-Step Tonal Ramp (50 to 950) Architecture

Every accent and neutral ramp in `r-ui` follows perceptually calibrated lightness curves:

```css
/* Tonal Ramp Semantic Mapping Table */
--r-ui-color-[name]-50:  /* Ultra-subtle hover tint, badge soft background */
--r-ui-color-[name]-100: /* Subtle active pill, selected row background */
--r-ui-color-[name]-200: /* Subtle border on light mode, elevated surface */
--r-ui-color-[name]-300: /* Standard interactive border on light mode */
--r-ui-color-[name]-400: /* Light accent state, dark mode disabled text */
--r-ui-color-[name]-500: /* Base primary accent on light mode */
--r-ui-color-[name]-600: /* Primary hover on light mode / Dark mode base primary */
--r-ui-color-[name]-700: /* Dark brand variant, active pressed state */
--r-ui-color-[name]-800: /* Deep dark mode surface, subtle text on light */
--r-ui-color-[name]-900: /* Deepest dark mode card surface, primary text on light */
--r-ui-color-[name]-950: /* Deepest dark canvas foundation */
```

---

### 1.4. The 8 Calibrated Accent Palettes (Zero-Neon Discipline)

`r-ui` bans fluorescent RGB neon values (`#00ff00`, `#ff00ff`, `#00ffff`) in favor of optically balanced, high-legibility shades:

1. **Cyan (`#38bdf8`)**: Precision Sky — Cloud infrastructure, data analytics, real-time telemetry.
2. **Emerald (`#10b981`)**: Deep Mint/Forest — Fintech, environmental tech, transaction ledgers.
3. **Violet (`#818cf8` / `#6366f1`)**: Electric Iris — AI workflows, developer tools, creative studios.
4. **Crimson (`#f43f5e`)**: Rich Carmine — Security consoles, incident ops, critical infrastructure.
5. **Amber (`#f59e0b`)**: Warm Honey — Analytics, logistics, operations, energy management.
6. **Coral (`#fb7185`)**: Sunset Rose — Modern consumer apps, community platforms, creative portfolios.
7. **Frost (`#67e8f9`)**: Arctic Glacier — Deep-sea telemetry, scientific tools, ambient instrumentation.
8. **Monochrome (`#e2e8f0` / `#94a3b8`)**: Editorial Slate — Minimalist portfolios, brutalist print aesthetic, legal tech.

---

### 1.5. The 4 Semantic Feedback Quartets

Semantic feedback must communicate status with zero ambiguity while preserving interface calmness:

```css
/* Success (Positive / Healthy / Online) */
--r-ui-color-success: #10b981;
--r-ui-color-success-bg: rgba(16, 185, 129, 0.12);
--r-ui-color-success-border: rgba(16, 185, 129, 0.25);

/* Warning (Degraded / Pending / Caution) */
--r-ui-color-warning: #f59e0b;
--r-ui-color-warning-bg: rgba(245, 158, 11, 0.12);
--r-ui-color-warning-border: rgba(245, 158, 11, 0.25);

/* Error / Destructive (Failed / Severed / Critical) */
--r-ui-color-error: #ef4444;
--r-ui-color-error-bg: rgba(239, 68, 68, 0.12);
--r-ui-color-error-border: rgba(239, 68, 68, 0.25);

/* Information (Notice / Neutral Status / Tip) */
--r-ui-color-info: #0ea5e9;
--r-ui-color-info-bg: rgba(14, 165, 233, 0.12);
--r-ui-color-info-border: rgba(14, 165, 233, 0.25);
```

> 🛡️ **Multi-Channel Accessibility Mandate**: Never represent status using color alone. Always pair status colors with an icon (checkmark, alert triangle, info circle) or text badge.

---

### 1.6. Contrast Science & WCAG 2.2 AAA Validation Matrix

All text and UI controls must satisfy strict contrast boundaries:
- **Body Copy & Input Text**: $\ge 4.5:1$ (WCAG AA) / $\ge 7.0:1$ (WCAG AAA).
- **Large Display Titles ($\ge 24\text{px}$)**: $\ge 3.0:1$ (WCAG AA) / $\ge 4.5:1$ (WCAG AAA).
- **Essential UI Controls & Borders**: $\ge 3.0:1$ against the adjacent canvas.
- **Dark Mode Halation Prevention**: In high-contrast dark modes, pure white text (`#ffffff`) on pure black (`#000000`) causes visual halation and eye fatigue. `r-ui` uses calibrated off-white (`#f8fafc` or `#f1f5f9`) for comfortable sustained reading.

---

## 🔤 PART 2: TYPOGRAPHIC COMPOSITION DOCTRINE

```text
+-----------------------------------------------------------------------------------------+
|                        THE 3-TIER TYPOGRAPHIC ARCHITECTURE                              |
+-----------------------------+-----------------------------+-----------------------------+
| TIER 1: DISPLAY & BRAND     | TIER 2: INTERFACE & BODY    | TIER 3: MONOSPACE TABULAR   |
| Character, Geometry, Scale  | Legibility, x-Height, Crisp | Fixed Pitch, Tabular Nums   |
| Plus Jakarta Sans / Geist   | Geist Sans / Inter Display  | JetBrains Mono / Geist Mono |
| Leading: 1.05 - 1.20 (Tight)| Leading: 1.50 - 1.65 (Prose)| Leading: 1.30 (Monospace)   |
| Tracking: -0.025em (Tight)  | Tracking: -0.005em (Neutral)| Tracking: 0.00em (Tabular)  |
+-----------------------------+-----------------------------+-----------------------------+
```

### 2.1. The 3-Tier Font Family Pairing Engine

Banning the boring "Inter-Everywhere" default while maintaining bulletproof fallback stacks:

```css
/* Tier 1: Display / Brand Stacks (Headings, Stat Values, Hero) */
--r-ui-font-display: "Plus Jakarta Sans", "Geist", -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;

/* Tier 2: Interface / Body Stacks (Inputs, Tables, Modals, Buttons) */
--r-ui-font-body: "Geist Sans", "Plus Jakarta Sans", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;

/* Tier 3: Tabular / Data / Monospace Stacks (Metrics, Timestamps, Logs, Code) */
--r-ui-font-mono: "JetBrains Mono", "Geist Mono", "SF Mono", Menlo, Consolas, monospace;
```

---

### 2.2. Fluid Clamp Modular Scales

Type scales scale dynamically with viewport width, eliminating abrupt breakpoint jumps:

```css
:root {
  /* Display & Headlines */
  --r-ui-font-hero:  clamp(2.25rem, 1.5rem + 3.75vw, 4.25rem);  /* 36px - 68px */
  --r-ui-font-h1:    clamp(1.85rem, 1.25rem + 2.5vw, 3rem);     /* 30px - 48px */
  --r-ui-font-h2:    clamp(1.5rem, 1.15rem + 1.6vw, 2.25rem);   /* 24px - 36px */
  --r-ui-font-h3:    clamp(1.25rem, 1.05rem + 1vw, 1.75rem);    /* 20px - 28px */
  --r-ui-font-h4:    clamp(1.1rem, 0.95rem + 0.5vw, 1.35rem);   /* 17px - 21px */

  /* Body & Interface */
  --r-ui-font-lead:  clamp(1.0625rem, 1rem + 0.25vw, 1.25rem);  /* 17px - 20px */
  --r-ui-font-base:  clamp(0.875rem, 0.85rem + 0.15vw, 1rem);   /* 14px - 16px */
  --r-ui-font-sm:    clamp(0.8125rem, 0.775rem + 0.1vw, 0.875rem); /* 13px - 14px */
  --r-ui-font-xs:    0.75rem;                                   /* 12px (Micro Labels) */
  --r-ui-font-badge: 0.6875rem;                                 /* 11px (Pill Tags) */
}
```

---

### 2.3. Leading & Vertical Rhythm Ratios

Line height must adapt inversely to font size:

```css
/* 1. Large Display Headings (Tight Leading) */
/* Loose leading on massive text causes words to drift apart visually */
.r-ui-heading-display {
  font-size: var(--r-ui-font-hero);
  line-height: 1.10; /* 110% */
}

/* 2. UI Elements, Buttons, Table Rows, Inputs (Snug Leading) */
/* Prevents vertical clipping inside fixed-height buttons (36px / 40px) */
.r-ui-ui-element {
  font-size: var(--r-ui-font-base);
  line-height: 1.35; /* 135% */
}

/* 3. Prose, Articles & Descriptive Paragraphs (Normal Reading Leading) */
/* Provides optimal eye-tracking return when reading multi-line paragraphs */
.r-ui-prose {
  font-size: var(--r-ui-font-base);
  line-height: 1.60; /* 160% */
  max-width: 68ch;   /* Optimal reading measure */
}
```

---

### 2.4. The Tracking Inversion Law (Letter-Spacing Discipline)

> **The Golden Law of Tracking**:  
> *The larger the glyphs, the tighter the tracking. The smaller the glyphs, the wider the tracking.*

```css
/* Large Headings: Negative Tracking (Pulls large glyphs into cohesive words) */
h1, .r-ui-h1 {
  letter-spacing: -0.025em;
}
h2, .r-ui-h2 {
  letter-spacing: -0.020em;
}

/* Standard Body: Neutral Tracking */
p, .r-ui-body {
  letter-spacing: -0.005em;
}

/* Micro-Labels, Uppercase Eyebrow Tags & Badges: Positive Tracking */
/* Prevents small uppercase letters from fusing together into illegible ink-blobs */
.r-ui-eyebrow,
.r-ui-badge-caps {
  font-size: var(--r-ui-font-xs);
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.06em; /* +6% */
}
```

---

### 2.5. Strict 3-Weight Discipline (Banning Weight Explosion)

A high-end interface never mixes 5 or 6 font weights. Restrict the entire view to strictly **3 active weights**:

```css
/* Weight 1: Regular (400) - Body text, table cells, descriptions */
--r-ui-weight-regular: 400;

/* Weight 2: Medium (500) - Field labels, table headers, nav items, button labels */
--r-ui-weight-medium: 500;

/* Weight 3: Semi-Bold (600) - Display titles, card headers, metric values */
--r-ui-weight-semibold: 600;

/* BANNED: Mixing 300, 400, 500, 600, 700, 800, 900 across the same screen. */
```

---

### 2.6. The 3-Tier Text Luminance Contrast Hierarchy

Guide the user's attention seamlessly with 3 calibrated text contrast levels:

```css
/* Tier 1: Primary Text (Headings, active values, selected tabs) */
--r-ui-color-text-primary: #f8fafc; /* Dark Canvas */
/* Light Canvas: #0f172a */

/* Tier 2: Secondary Text (Descriptions, field labels, metadata keys) */
--r-ui-color-text-secondary: #94a3b8; /* Dark Canvas */
/* Light Canvas: #475569 */

/* Tier 3: Tertiary / Muted Text (Timestamps, shortcuts, breadcrumb dividers) */
--r-ui-color-text-tertiary: #64748b; /* Dark Canvas */
/* Light Canvas: #94a3b8 */
```

---

### 2.7. Tabular Figures Mandate for Numeric Data

In dashboards, analytics, financial ledgers, and telemetry, numbers **MUST NOT JITTER**:

```css
.r-ui-tabular-number {
  font-family: var(--r-ui-font-mono);
  font-variant-numeric: tabular-nums;
  text-align: right;
}
```

---

## 📋 PRE-FLIGHT COLOR & TYPOGRAPHY AUDIT CHECKLIST

Before approving any UI deliverable, verify:
- [ ] **60-30-10 Ratio**: Canvas neutrals represent 60%, structural secondary 30%, and accent $\le 10%$.
- [ ] **Undertone Purity**: No mixing of cool slate, neutral zinc, or warm stone undertones.
- [ ] **Zero Neon**: No raw `#00ff00`, `#ff0000`, or `#00ffff` fluorescent glows.
- [ ] **Multi-Channel Semantics**: Feedback states include both color and shape/icon cues.
- [ ] **3-Tier Font Pairing**: Display, Interface Body, and Monospace Tabular are clearly delineated.
- [ ] **Tracking Inversion**: Negative tracking on large titles (`-0.02em`), positive tracking on micro caps (`+0.06em`).
- [ ] **3-Weight Maximum**: Only weights 400, 500, and 600 are used across the interface.
- [ ] **Tabular Numerics**: All numeric telemetry and table data use `font-variant-numeric: tabular-nums;`.
- [ ] **WCAG 2.2 AA Contrast**: All body text achieves $\ge 4.5:1$ contrast against adjacent background.
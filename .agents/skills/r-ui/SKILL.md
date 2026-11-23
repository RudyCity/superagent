---
name: r-ui
description: Universal UI/UX Design System, Multi-Theme, Modular Color Accent, 9-Pillar Complete Dashboard Kit Architecture (45+ Production Components), Spatial Harmony & Layout Precision Doctrine, Color Science & Palette Architecture (60-30-10, Tonal Ramps, Undertones), Typographic Composition Doctrine (3-Tier Font Pairing, Modular Scale, Leading Ratios, Tracking Inversion, 3-Weight Discipline), Kinetic Physics & Micro-Interactions (Designspells Delight, Spring Curves, Tactile Press), Accessibility & Keyboard Spatial Navigation (WCAG 2.2 AAA Double-Ring Focus, Roving Tabindex, ARIA Live Regions), Component State Machine Exhaustiveness (6 Universal Visual States), Unified Canvas & Line-less Workspace Doctrine (Seamless Master-Detail, Unified Title Bar & Floating Action Dock), On-Demand Bespoke SVG Icon Crafting Doctrine (24x24 Optical Grid, 1.5px Geometry, Zero-Dependency Theme Reactivity), Project-Adaptive & Live Playground Architecture Skill. Enforces anti-slop aesthetic standards (11 Anti-Slop Visual Laws: zero thick asymmetric left borders, crisp 1px uniform perimeter, zero generic purple haze, zero neon, zero heavy shadows), anti-rigid project adaptation (5 project archetypes & 4 visual dials), visual-first density, dual-layer theming (5 Canvas Themes + 8 Calibrated Color Themes), strict componentized form policy (zero raw native forms), headless/unstyled component flexibility, live interactive showcase, multi-framework integration (React, Next.js, Tailwind v3/v4, Vue, Svelte, Ink CLI), fluid cross-platform responsiveness (Web, Windows, macOS, Linux, Android, iOS, Foldables, Smart TV), and integration with curated design references (jiro.build, designspells.com, styles.refero.design, supahero.io, mobbin.com).
when_to_use: Use whenever designing, building, auditing, refactoring, or reviewing user interfaces (UI), user experiences (UX), dashboard kits, admin consoles, SaaS platforms, responsive layouts, design systems, design tokens, micro-interactions, components, color themes, project adaptation, interactive showcases, or cross-platform web/app experiences.
version: 3.3.0
---

# r-ui: Universal UI/UX Design System & Visual-First Architecture

`r-ui` is the authoritative operational skill for engineering production-grade user interfaces (UI) and user experiences (UX) with top-tier agency aesthetics: **Visual-First**, **Dense & Concise (Anti-Wall-of-Text)**, **Free of Murky Heavy Shadows**, **Free of Neon & Cyberpunk Glows**, **Free of Thick Asymmetric Left Borders (100% Crisp 1px Uniform Perimeter)**, **Adaptive to Project DNA**, and **Context-Aware Token Architecture** (Standard clean `--r-ui-*` namespace for greenfield projects, with zero-friction adaptation to any existing project token system).

---

## 1. THE 11 ANTI-SLOP VISUAL LAWS (Non-Negotiable)

```text
+---------------------------------------------------------------------------------+
|                       THE 11 ANTI-SLOP DESIGN LAWS                              |
+---------------------------------------------------------------------------------+
|  1. BAN THE PURPLE HAZE     ---> No generic AI-purple/pink mesh gradients       |
|  2. BAN SYMMETRIC BENTO     ---> Asymmetric weights & hierarchy (2:1 spans)     |
|  3. BAN INTER MONOCULTURE   ---> Distinctive display + refined body font        |
|  4. BAN GLASS OVERDOSE      ---> Max blur 6-8px, crisp 1px borders only         |
|  5. BAN POINTLESS MOTION    ---> Purposeful haptic springs, no loop spin        |
|  6. BAN MOCK DATA VAGUENESS ---> Realistic domain data, zero "Lorem Ipsum"      |
|  7. BAN HEAVY MUDDY SHADOWS ---> Zero thick black blur; crisp micro-elevations  |
|  8. BAN NEON & CYBERPUNK    ---> Calibrated optical tones; zero glow rings      |
|  9. BAN RAW NATIVE FORMS    ---> Zero unstyled <select>; 100% componentized     |
| 10. BAN COLOR HIJACKING     ---> Honor existing color system; zero rogue hex    |
| 11. BAN THICK LEFT BORDERS  ---> Zero border-l-4/asymmetric strips; 1px uniform  |
+---------------------------------------------------------------------------------+
```

### Detailed Mandate for Law 11: Absolute Ban on Thick Left Borders & Asymmetric Accent Strips
- **The Visual Defect (Corner Curvature Collision)**: Applying an asymmetric thick border (`border-l-4`, `border-l-2`, `border-left: 3px/4px solid ...`) to a container with rounded corners (`border-radius`) severely distorts corner geometry. The top-left and bottom-left curves bend awkwardly into asymmetrical ellipses, creating an amateurish and deformed visual appearance.
- **The Outdated AI-Slop Artifact**: Thick colored left border strips on active navigation items, workspace cards, alerts, or callout blocks are obsolete relics of 2016-era Bootstrap templates and low-effort Tailwind starter kits. High-end modern design systems (Linear, Apple, Vercel, Raycast, Supabase) **NEVER** use thick asymmetric border strokes on rounded cards or active list items.
- **Mandatory Modern Replacements**:
  1. **Crisp 1px Uniform Perimeter**: Maintain an uninterrupted, uniform 1px hairline border around all four edges (`border: 1px solid var(--r-ui-color-border-standard)`).
  2. **Soft Tint Active Background**: Communicate selected or active states using a soft tonal background fill (`background: rgba(var(--r-ui-color-accent-primary-rgb), 0.08)`) coupled with a subtle 1px border accent (`border-color: rgba(var(--r-ui-color-accent-primary-rgb), 0.35)`).
  3. **Decoupled Floating Indicator Pill**: If a directional vertical indicator is required to indicate active selection, **decouple it completely from the container's border stroke**. Render a separate floating vertical capsule/pill inside the item padding (e.g. `width: 3px; height: 16px; border-radius: 9999px; background: var(--r-ui-color-accent-primary); margin-right: 8px;`), preserving pristine card borders.
  4. **Subtle 1px Optical Focus / Selection Ring**: Utilize an interior or exterior 1px box-shadow ring (`box-shadow: 0 0 0 1px var(--r-ui-color-accent-primary)`), never an unbalanced single-edge border width.

---

## 2. PROJECT-ADAPTIVE DIALS (Anti-Rigid Design Engine)

Never force an identical template across diverse software architectures. Every interface generated or audited by `r-ui` must consciously configure 4 visual dials:

1. **Information Density Dial (1 to 10)**:
   - `1-3 (Spacious / Editorial)`: Marketing sites, luxury portfolios, reading portals (`padding: 24-32px`, `gap: 24px`).
   - `4-6 (Balanced SaaS)`: Default consumer dashboards, settings panels, workspace feeds (`padding: 16-20px`, `gap: 16px`).
   - `7-10 (High-Density Professional)`: Financial trading desks, DevOps telemetry, cloud logs, data tables (`padding: 6-10px`, `gap: 8px`).
2. **Corner Radius Scale (0px to 24px)**:
   - `Sharp (0-2px)`: Industrial, brutalist, fintech, terminal tools.
   - `Subtle / Clean (4-8px)`: Professional B2B SaaS, dev tools, cloud platforms.
   - `Soft / Friendly (10-16px)`: Consumer apps, education, lifestyle products.
   - `Exaggerated Squircle (20-28px)`: Playful tech, modern creative portfolios.
3. **Motion Energy (Subtle to Expressive)**:
   - Always utilize real-world physical spring curves: `cubic-bezier(0.16, 1, 0.3, 1)` or `cubic-bezier(0.2, 0.9, 0.2, 1)`.
   - Durations strictly between `180ms` (snappy micro-interactions) and `280ms` (dialog transitions).
4. **Visual Contrast Level**:
   - Strictly satisfies WCAG 2.2 AA / AAA (minimum 4.5:1 for body copy, 3:1 for large display titles and UI controls).

---

## 3. THE 5 DESIGN ARCHETYPES (Instant Context Switching)

1. **Fintech & Mission-Critical Banking**:
   - Zero-radius or tight 4px corners, strict tabular monospace numerics (`tabular-nums`), high contrast, emerald positive deltas, crimson warnings, zero decorative illustrations.
2. **Developer Tools & DevOps Telemetry**:
   - Deep slate/zinc canvas, compact 8px padding, terminal log consoles, status pulse badges, command palettes (`Ctrl+K`), live latency indicators.
3. **Enterprise B2B SaaS**:
   - Balanced 16px padding, subtle 8px radius, multi-layer breadcrumbs, powerful faceted data tables, slide-over drawer inspectors.
4. **Editorial Luxury & Publishing**:
   - Warm sepia/stone tones, high-contrast serif/grotesk typography pairings, wide asymmetric whitespace, film-grain texture overlays, generous line-height (`1.65`).
5. **Modern Consumer & Social Platform**:
   - Soft squircle cards (12-16px), bottom-sheets on mobile viewports, responsive micro-interactions, optimistic UI updates.

---

## 4. DUAL-LAYER THEMING ARCHITECTURE (Canvas + Accent Separation)

`r-ui` decouples **Canvas Backgrounds** from **Accent Color Themes**, unlocking 40 clean visual pairings:

```html
<!-- Combine Canvas Theme and Color Accent freely -->
<html data-r-ui-theme="dark-nebula" data-r-ui-accent="cyan">
<!-- Or Slate Obsidian with Crimson Accent -->
<html data-r-ui-theme="slate-obsidian" data-r-ui-accent="crimson">
```

### 1. Canvas Themes (`data-r-ui-theme`)
- **`dark-nebula`**: Refined modern dark tech (deep slate background `#07090e`).
- **`clean-light`**: High-contrast crisp daylight (pure white background `#ffffff` with neutral zinc surfaces).
- **`slate-obsidian`**: Ultra-deep OLED black (`#040405`) with 1px border elevation.
- **`warm-sepia`**: Editorial paper tone (`#faf8f5` canvas, `#1c1917` typography).
- **`glass-frosted`**: Semi-transparent frosted backdrop with hardware-accelerated blur.

### 2. Accent Color Themes (`data-r-ui-accent`)
- `cyan` (#38bdf8), `emerald` (#10b981), `violet` (#818cf8), `crimson` (#f43f5e), `amber` (#f59e0b), `monochrome` (#e2e8f0), `frost` (#67e8f9), `coral` (#fb7185).

*Design tokens & theme definitions:* [r-ui-color-themes.css](references/r-ui-color-themes.css) and [r-ui-themes.css](references/r-ui-themes.css).

---

## 5. CURATED DESIGN REFERENCES INTEGRATION

When designing, reviewing, or refactoring UI/UX, verify patterns against the 5 essential references:
1. **[jiro.build](https://jiro.build)**: 1,400+ production component layouts, bento blocks, and pricing cards via MCP `jiro`.
2. **[designspells.com](https://designspells.com)**: Micro-interactions, delight moments, fluid spring physics, and tactile feedback.
3. **[styles.refero.design](https://styles.refero.design)**: Real audited typography pairings, color tokens, and tonal ramps.
4. **[supahero.io](https://supahero.io)**: High-impact hero section architectures, value-prop visual framing, and header layouts.
5. **[mobbin.com](https://mobbin.com)**: Real app user flows, multi-step onboarding, and mobile transitions via MCP `mobbin`.

*Complete guide:* [curated-design-references](../../skills/curated-design-references/SKILL.md).

---

## 6. MODULAR CODE DELIVERABLES

- 🏛️ **Master Blueprint Dashboard Kit (9 Pillars & 45+ Components)**: [r-ui-dashboard-kit-spec.md](references/r-ui-dashboard-kit-spec.md)
- 🎯 **On-Demand Bespoke SVG Icon Crafting Specification**: [r-ui-on-demand-icon-crafting.md](references/r-ui-on-demand-icon-crafting.md)
- ⚡ **Kinetic Interaction, Accessibility & State Spec**: [r-ui-interaction-and-accessibility-spec.md](references/r-ui-interaction-and-accessibility-spec.md)
- 🎨 **Color Science & Typographic Composition Doctrine**: [r-ui-color-and-typography-doctrine.md](references/r-ui-color-and-typography-doctrine.md)
- 📜 **TypeScript Contract Types Boilerplate**: [r-ui-contract-types.ts](references/r-ui-contract-types.ts)
- 📦 **Compound Components (`unstyled?: boolean`)**: [r-ui-compound-components.tsx](references/r-ui-compound-components.tsx)
- 🎛️ **Interactive Theme & Accent Switcher Widget**: [r-ui-theme-switcher.tsx](references/r-ui-theme-switcher.tsx)
- ⚙️ **Multi-Framework Adapters (React, Tailwind, Vue, Svelte, Ink)**: [r-ui-framework-adapters.md](references/r-ui-framework-adapters.md)
- 🏛️ **Atomic Modular Architecture Guide**: [r-ui-modular-architecture.md](references/r-ui-modular-architecture.md)
- 🎮 **Interactive Live Showcase**: [r-ui-showcase.html](references/examples/r-ui-showcase.html)

---

## 7. COMPLETE TECHNICAL REFERENCES

- 🏛️ **Complete Dashboard Kit Specification**: [r-ui-dashboard-kit-spec.md](references/r-ui-dashboard-kit-spec.md)
- 🎯 **On-Demand SVG Icon Crafting Protocol**: [r-ui-on-demand-icon-crafting.md](references/r-ui-on-demand-icon-crafting.md)
- ⚡ **Interaction Physics & Accessibility Specification**: [r-ui-interaction-and-accessibility-spec.md](references/r-ui-interaction-and-accessibility-spec.md)
- 🎨 **Color Science & Typographic Composition Specification**: [r-ui-color-and-typography-doctrine.md](references/r-ui-color-and-typography-doctrine.md)
- 🎨 **Standard Design Tokens**: [r-ui-tokens.css](references/r-ui-tokens.css)
- 📐 **Visual Component Specifications**: [r-ui-component-specs.md](references/r-ui-component-specs.md)
- 📱 **Multi-Device Responsive Matrix Guide**: [r-ui-responsive-matrix.md](references/r-ui-responsive-matrix.md)
- 🔌 **Live MCP Workflow (Jiro & Mobbin)**: [r-ui-mcp-workflow.md](references/r-ui-mcp-workflow.md)
- 🕹️ **Playground Documentation**: [README.md](references/examples/README.md)

---

## 8. PRE-FLIGHT UI/UX AUDIT CHECKLIST (28-Point Master Gate)

```text
[ ] 1.  Anti-Slop Check: Free of AI-purple mesh gradients, monotonous uniform bentos, & "Lorem Ipsum" dummy text.
[ ] 2.  Anti-Neon Check: Free of blinding fluorescent colors and radioactive glowing box-shadows.
[ ] 3.  Anti-Heavy Shadow Check: Free of murky thick black drop-shadows; use crisp 1-3px micro-elevations.
[ ] 4.  Visual Density: Concise, high-density copy, strong visual hierarchy, strict 4pt/8pt harmonic spacing.
[ ] 5.  Project DNA Match: Dials (Density, Radius, Motion, Contrast) calibrated to project archetype.
[ ] 6.  Token & Namespace Adaptation: For existing projects, strictly adopt and reuse existing project tokens/classes (do NOT force --r-ui-*). For greenfield projects, use standard --r-ui-* tokens.
[ ] 7.  Mobile Ergonomics: Min 44x44px touch targets, bottom-sheets on mobile viewports, safe-area-inset.
[ ] 8.  Desktop Multi-Window: Crisp fractional DPI scaling, explicit navigation shortcuts.
[ ] 9.  10-Foot UI (TV): D-Pad spatial navigation (Arrow keys), 1.08x focus magnification, high-contrast outlines.
[ ] 10. Contrast Ratio: Passes WCAG 2.2 AA (min 4.5:1 for body copy, 3:1 for large text).
[ ] 11. Dual-Layer Theming: Components respond dynamically to data-r-ui-theme and data-r-ui-accent.
[ ] 12. Fluid Typography: Proportionate clamp() scaling with zero layout breakages upon zoom.
[ ] 13. Spring Motion: Spring physics cubic-bezier(0.16, 1, 0.3, 1), 180-260ms duration.
[ ] 14. Modality Awareness: Components distinguish touch input from precision mouse pointers.
[ ] 15. Unstyled Flexibility: Supports unstyled?: boolean mode for headless consumer customization.
[ ] 16. Zero-Dependency: No mandatory external third-party UI libraries forced on consumers.
[ ] 17. Componentized Form Check: 100% free of raw native <select>, checkbox, or radio; fully utilizes r-ui Custom Form Components.
[ ] 18. Dashboard Completeness Gate: Covers all 9 pillars of dashboard kit architecture (Shell, Telemetry, Data Tables, Visualization, Custom Forms, Overlays, Navigation, Identity, and DevOps Console).
[ ] 19. Existing Color & Theme Conformance: Pre-flight audit performed; 100% of new/modified elements strictly conform to existing CSS variables, tokens, and active themes (zero rogue hardcoded hex/rgb).
[ ] 20. Spatial Rhythm & Layout Harmony: Negative space (macro/micro whitespace) balanced via 4pt/8pt scale; container padding proportionate to content; zero trapped dead-space, zero layout breakages, and precision optical alignment.
[ ] 21. Color Palette & Undertone Coherence: Follows 60-30-10 distribution; coherent neutral undertones (cool/slate, neutral/zinc, or warm/stone); calibrated accent (<=10%); free of blinding fluorescent neon.
[ ] 22. Typographic Composition & Tracking Discipline: 3-tier font pairing (Display, UI/Body, Tabular Mono); proportional leading (tight 1.1-1.2 on large titles, compact 1.35 on UI, 1.6 on prose); tracking inversion law (-0.02em on headings, +0.06em on micro-caps); strict max 3 font weights.
[ ] 23. Kinetic Micro-Interactions & Spring Dynamics: All transitions use calibrated cubic-bezier springs; interactive buttons feature tactile scale depression (scale 0.975); staggered cascade delays on lists.
[ ] 24. Accessibility & Keyboard Spatial Navigation: Passes WCAG 2.2 AAA focus-visible criteria (2px ring + 2px offset + 4px canvas shadow); roving tabindex on toolbars/tabs; overlays trap focus and restore it on Escape.
[ ] 25. State Machine Exhaustiveness: 100% of interactive components explicitly define all 6 universal states (Idle, Hover, Active, Focus-Visible, Disabled, Loading/Skeleton) with zero visual ambiguity.
[ ] 26. Anti-Thick Left Border & Asymmetric Strip Check: 100% free of asymmetric border-l-4 / border-l-2 or thick accent bars on rounded cards, callouts, and active items; strictly utilizes crisp 1px uniform perimeter borders and soft background tint or decoupled floating indicators.
[ ] 27. Unified Canvas & Line-less Workspace Check: For modern productivity/developer tools and AI workspaces, validates seamless canvas integration without boxy hard dividers between sidebar and workspace, unified compact header/titlebar, floating action dock, and Gestalt negative-space separation.
[ ] 28. On-Demand Bespoke SVG Icon Check: When icons are needed, validates that icons are crafted on a 24x24 optical grid (2px margin) with crisp 1.5px stroke, stroke="currentColor", round linecap/linejoin, zero neon filter slop, and proper WCAG accessibility (aria-hidden="true" on decorative icons, aria-label on interactive controls).
```

---

## 9. STRICT COMPONENTIZED FORM POLICY (Zero Raw Native Forms)

Agents are **STRICTLY PROHIBITED** from using unstyled raw native browser form elements, particularly native `<select>` and `<option>`.

### Why Are Raw Native `<select>` Elements Banned?
1. **OS Popups Break Dark Modes**: Native `<select>` renders an unstyleable OS-level popup window (Win32 / Cocoa) that frequently displays a blinding white background in dark-mode themes.
2. **Inconsistent Cross-Platform Aesthetics**: Native dropdowns look vastly different across Windows, macOS, Android, and iOS, breaking visual polish.
3. **Accessibility & Search Deficits**: Native selects lack built-in real-time filtering, fuzzy search, custom item status badges, and custom icons.

### Mandatory Standard: r-ui Custom Accessible Form Components
Every selection input must use **r-ui Custom Select Components**:
- **Trigger Button**: Displays active label, status icon, and animated chevron indicator.
- **Floating Popover Menu**: Elevated surface with hardware-accelerated backdrop blur, subtle 1px border (`--r-ui-color-border-standard`), and smooth spring entrance animation.
- **Search & Filter Input**: Real-time filtering within popover for lists with more than 6 options.
- **W3C ARIA & Keyboard Compliance**: Full support for `role="combobox"`, `role="listbox"`, `role="option"`, `aria-expanded`, and keyboard navigation (`ArrowUp`, `ArrowDown`, `Enter`, `Escape`).

*Complete form specifications:* [r-ui-component-specs.md](references/r-ui-component-specs.md).

---

## 10. MANDATORY 9-PILLAR (45+ COMPONENT) ARCHITECTURE FOR DASHBOARD KITS

Whenever tasked with building a Dashboard Kit or UI Kit with `r-ui`, agents **MUST DELIVER THE COMPLETE 9-PILLAR SUITE (45+ PRODUCTION COMPONENTS)**. Partial or truncated cockpit monitors are strictly banned:

1. **Pillar 1 — Shell & Navigation**: Collapsible Sidebar (Expanded 240px & Mini-Rail 60px), Workspace/Org Switcher, Top Header, Breadcrumb Trail, Page Action Toolbar, Master-Detail Inspector Drawer.
2. **Pillar 2 — Metrics & Telemetry**: High-Density Stat Cards (Value, Delta %, Context Subtitle), Architectural Telemetry Ribbon (Anti-Card Overuse), Segmented Quota Gauges, 90-Day Uptime Strip & Live Latency Pulse Dot.
3. **Pillar 3 — Data Tables & Collections**: High-Density Data Grid, Sortable Headers, Custom Row Checkbox (Indeterminate Support), Floating Bulk Action Bar, Pagination & Page Size Selector, Faceted Filter Popovers & Active Filter Chips, Empty States, Skeleton Shimmer.
4. **Pillar 4 — Data Visualization**: Time-Series Area Curves with interactive crosshair, Grouped/Stacked Bar Charts, Donut Distribution with center aggregate & legend, Latency Histogram, Interactive Chart Tooltips.
5. **Pillar 5 — Form & Inputs (Zero Native Forms)**: Custom Accessible Select (Searchable, Popover), Multi-Select with Removable Chips, Date & Date-Range Picker, Prefix/Suffix Inputs, Number Steppers, Textarea with Counter, Tactile Spring Switch, Custom Checkbox & Radio Cards, Dual-Thumb Range Slider, Drag-and-Drop Dropzone.
6. **Pillar 6 — Feedback, Overlays & Drawers**: Modal Dialogs with backdrop blur, Slide-Over Sheet / Inspector Drawer, Slide-in Toast Stack (Success/Error/Warning/Info/Undo), Alert Banners, Destructive Confirmation Dialog, Micro Tooltips, Context Menu Popover.
7. **Pillar 7 — Navigation & Wayfinding**: Command Palette (`Ctrl+K` / `⌘+K`) with fuzzy search, Segmented Controls, Line/Pill Tabs, Stepper / Multi-Step Wizard, Tree Views.
8. **Pillar 8 — Identity, Display & Content**: Avatars & Stacked Avatar Groups with online presence dot, Status Badges with animated pulse dot, Activity Timeline / Audit Feed, Key-Value Metadata Grid, Code Snippet & JSON Inspector.
9. **Pillar 9 — Real-Time & DevOps Consoles**: Live Streaming Monospace Terminal Console (INFO/WARN/ERR/DEBUG, auto-scroll lock, log search), Secret Masking Env Var Editor, Latency Ping Meter.
10. **Interactive Component Showcase**: Must provide a live interactive catalog tab/page where all components across all 9 pillars can be tested for functionality and theme reactivity.

*Technical specifications & master blueprint:* [r-ui-dashboard-kit-spec.md](references/r-ui-dashboard-kit-spec.md).

---

## 11. MANDATORY EXISTING COLOR & THEME CONFORMANCE PROTOCOL

Whenever creating new components, refactoring code, or modifying user interfaces in an existing codebase, agents **MUST OBEY THIS 4-STEP PROTOCOL BEFORE WRITING ANY CODE**:

```text
+---------------------------------------------------------------------------------+
|             EXISTING COLOR & THEME CONFORMANCE WORKFLOW                         |
+---------------------------------------------------------------------------------+
| 1. DISCOVERY & MAPPING ---> Audit :root, tokens, CSS vars, & active themes      |
| 2. ZERO FORCED NAMESPACE -> Never force --r-ui-* if project has its own tokens  |
| 3. ZERO ROGUE COLORS   ---> Ban hardcoded hex/rgb; 100% map to existing vars    |
| 4. THEME REACTIVITY    ---> Ensure dynamic adaptation to dark/light/accents     |
+---------------------------------------------------------------------------------+
```

### Context-Aware Token & Namespace Rule: Never Force `--r-ui-*` on Existing Codebases
- **Existing Projects**: If the project already has its own design tokens, CSS variables, or class utility conventions (such as `--background`, `--foreground`, `--primary`, `--border` in Shadcn/Radix, or `--color-*`, `--theme-*`, or Tailwind `@theme` utilities), the agent **MUST NOT** force `--r-ui-*` variables onto the project. Instead, adapt component styles directly to the project's native variables and conventions!
- **Greenfield / Standalone**: If the project is greenfield or has no established design tokens, default to the standard `--r-ui-*` namespace as the pristine foundation.

### Step 1: Pre-Flight Color & Theme Discovery Audit
Before writing a single line of CSS or component styling:
1. **Inspect Token & Style Files**: Search for `:root`, `tokens.css`, `themes.css`, `globals.css`, `tailwind.config`, or HTML attributes like `data-theme`, `data-r-ui-theme`, `data-r-ui-accent`.
2. **Map Semantic Roles to Project Variables**:
   - **Canvas & Surface**: Identify background base tokens (e.g. project's `--background`, `--color-canvas`, or `--r-ui-color-canvas`).
   - **Borders & Hairlines**: Identify border tokens (e.g. project's `--border`, `--color-border-standard`, or `--r-ui-color-border-standard`).
   - **Typography Hierarchy**: Identify text tokens (e.g. project's `--foreground`, `--color-text-primary`, or `--r-ui-color-text-primary`).
   - **Accents & Interactive States**: Identify brand/accent tokens (e.g. project's `--primary`, `--ring`, `--color-accent-primary`, or `--r-ui-color-accent-primary`).

### Step 2: Strict Ban on Rogue Hardcoded Colors (Zero Rogue Hex/RGB)
- **Absolute Rule**: Agents are **STRICTLY FORBIDDEN** from writing arbitrary hardcoded colors like `background: #1e293b; color: #64748b;` when the project already provides CSS variables such as `var(--background)`, `var(--color-surface)`, or `var(--r-ui-color-surface-elevated)`.
- All new and modified elements **100% MUST CONSUME EXISTING CSS VARIABLES / DESIGN TOKENS**.
- Violating an existing color system is classified as **UNACCEPTABLE SLOP & DESIGN INCONSISTENCY**.

### Step 3: Multi-Theme Reactivity Verification
- Every added or modified component must be validated across active canvas themes (e.g. switching from dark to light mode or between custom palettes).
- No static hardcoded text or background color may be used that results in broken contrast when the user changes themes.

### Step 4: Controlled Color Extension Protocol
- If a component requires a transparency or shade not yet exposed, **NEVER invent arbitrary colors**.
- Derive strictly using `rgba()` with registered accent tokens (e.g. `rgba(var(--primary-rgb), 0.15)` or `rgba(var(--r-ui-color-accent-primary-rgb), 0.15)`) or standard ramps (`50` through `950`).
- If a new permanent design token is genuinely required, declare it formally in the project's primary design token registry first.

---

## 12. SPATIAL HARMONY & PRECISION LAYOUT DOCTRINE (Macro/Micro Whitespace, Container Balance & Visual Cleanliness)

World-class interfaces are defined by **cleanliness, visual neatness, mathematical precision, consistency, and an exquisite balance between negative space (whitespace) and container content**. Negative space is not "wasted room", but an active architectural element that guides optical focus, provides cognitive breathing room, and establishes effortless hierarchy.

```text
+---------------------------------------------------------------------------------+
|                     THE 5 PILLARS OF SPATIAL HARMONY                            |
+-----------------+-----------------+-----------------+-------------+-------------+
| 1. 4pt/8pt Grid | 2. Gestalt Space| 3. Nested Radius| 4. Density  | 5. Optical  |
| Strict Harmonic | Macro vs Micro  | R_outer =       | Zero Dead   | Tabular &   |
| Multiples Only  | Proximity Ratios| R_inner + P     | Space Bounds| Axis Lock   |
+-----------------+-----------------+-----------------+-------------+-------------+
```

### 12.1. Strict 4pt / 8pt Harmonic Grid System
Every structural `padding`, `margin`, `gap`, `width`, and `height` **MUST BE A MULTIPLE OF 4px OR 8px**.
- **Strict Ban on Arbitrary Odd Values**: Never write arbitrary padding/margin like `margin-top: 13px;`, `gap: 17px;`, `padding: 22px;`, or `width: 317px;`.
- **Standard r-ui Spacing Scale**:
  - `4px` (`--r-ui-space-1`): Micro-gap (icon to label text, status dot to text, badge vertical padding).
  - `8px` (`--r-ui-space-2`): Compact-gap (spacing between input groups, list item padding, compact button).
  - `12px` (`--r-ui-space-3`): Standard-inner (form field gaps, compact card padding, subtitle margins).
  - `16px` (`--r-ui-space-4`): Standard container (card padding, standard flexbox gap, grid gap).
  - `24px` (`--r-ui-space-6`): Macro-gap (spacing between major cards, modal dialog padding, page toolbar padding).
  - `32px` (`--r-ui-space-8`): Section separation (spacing between major sections, outer container padding).
  - `48px` / `64px` (`--r-ui-space-12` / `16`): Hero section padding, empty state padding, or major dashboard splits.

### 12.2. Gestalt Proximity & Macro vs Micro Whitespace Ratios
Functionally related elements must sit closer to one another (*micro space*) than to distinct container boundaries (*macro space*).
- **The 1.5x - 2x Whitespace Hierarchy**:
  $$\text{Section Gap (24-32px)} > \text{Card Padding (16-24px)} > \text{Item Gap (8-12px)} > \text{Label-to-Input (4-6px)}$$
- **Example Slop Mistake**: A card title sits 20px away from its body, but the gap between two independent cards is only 12px. This destroys cognitive visual grouping.
- **Correct Spacing Pattern**:
  ```css
  /* CORRECT: Multi-tier spacing hierarchy */
  .r-ui-stat-card {
    padding: 16px;          /* Container padding */
    display: flex;
    flex-direction: column;
    gap: 12px;              /* Macro internal gap */
  }
  .r-ui-stat-card-header {
    display: flex;
    align-items: center;
    gap: 8px;               /* Micro icon-to-title gap */
  }
  .r-ui-stat-card-value {
    font-size: 24px;
    line-height: 1.2;
    margin-bottom: 2px;     /* Ultra-tight title to delta */
  }
  ```

### 12.3. Mathematical Nested Radius Formula
When an element sits inside a container with rounded corners (`border-radius`), the inner element's radius **MUST NOT EQUAL OR EXCEED** the outer radius.
- **Pure Concentric Radius Formula**:
  $$R_{\text{inner}} = \max(0, R_{\text{outer}} - \text{Padding})$$
- If the outer container has $R_{\text{outer}} = 16\text{px}$ and internal padding $\text{Padding} = 12\text{px}$, the inner child radius must be:
  $$R_{\text{inner}} = 16\text{px} - 12\text{px} = 4\text{px}$$
- **Why is this critical?** If the inner child uses the same radius as the outer container (e.g. both `16px`), the curves collide into an unsightly pinch (*corner pinch collision*), signaling amateur craftsmanship.

### 12.4. Container-to-Content Ratio & Zero Trapped Dead-Space
- **Anti Trapped Dead-Space**: Never place small content (e.g. a single line of text or one lone button) inside a giant `width: 100%` container spanning 1400px without upper bounds. Always enforce proportional `max-width`:
  - *Forms & Settings*: `max-width: 640px` or `720px`.
  - *Reading Text & Paragraphs*: `max-width: 65ch` to `72ch` (optimal human reading measure).
  - *Stat Cards / Metrics*: `grid-template-columns: repeat(auto-fit, minmax(260px, 1fr));`.
- **Anti Claustrophobia**: Text must never touch container borders. Enforce at least `16px` padding on desktop cards and `12px` on mobile cards.
- **Vertical Asymmetric Harmony (Optical Header Ratio)**:
  - Card headers must be more compact than the card body ($P_{\text{header-v}} \approx 0.75 \times P_{\text{card-v}}$).

### 12.5. Precision Optical Alignment & Tabular Metrics
- **Mandatory Tabular Numbers on Dashboards**: All numeric figures in tables, metrics, balances, latency meters, and prices **MUST** declare:
  ```css
  font-variant-numeric: tabular-nums;
  text-align: right; /* for comparable table data */
  ```
  This eliminates horizontal shifting and jittering when numbers update or are visually scanned in column rows.
- **Optical Axis Vertical Centering**: Any inline pairing of `icon + text` or `badge + title` must declare `display: inline-flex; align-items: center; gap: 6px;` to lock a precise horizontal axis.
- **Baseline Alignment**: For adjacent controls (e.g. an input text field next to a submit button), guarantee identical heights (e.g. both `36px` or `40px`) with `box-sizing: border-box;` active to prevent 1px visual offsets.

### 12.6. Mandatory Layout Hygiene Checklist
Before marking any layout or component complete:
1. `[ ]` Do all padding, margin, and gap values strictly adhere to multiples of 4px/8px?
2. `[ ]` Does negative space feel breathable without feeling vacant (zero trapped dead-space)?
3. `[ ]` Do nested rounded elements strictly follow $R_{\text{inner}} = R_{\text{outer}} - P$?
4. `[ ]` Do all numeric metrics use `tabular-nums` and align cleanly?
5. `[ ]` Does the container adapt fluidly across viewports without unintended horizontal scrollbars?
6. `[ ]` Are all borders crisp, uniform 1px around the full perimeter (100% free of thick asymmetric left borders or `border-l-4` on rounded containers)?

### 12.7. Crisp Uniform 1px Perimeter & Ban on Asymmetric Left Borders (Anti-Slop Callout & Card Doctrine)

```text
+---------------------------------------------------------------------------------+
|              UNIFORM 1PX PERIMETER VS THICK ASYMMETRIC BORDER SLOP             |
+---------------------------------------------------------------------------------+
| ❌ SLOP:  border-left: 4px solid var(--accent); border-radius: 8px; (Distorted) |
| ✅ R-UI:  border: 1px solid var(--border); bg: rgba(accent, 0.08); + Pill Dot   |
+---------------------------------------------------------------------------------+
```

#### Why Are Thick Left Borders Banned on Rounded Containers?
1. **Geometric Corner Distortion**: When `border-left-width` (e.g. 3px or 4px) differs from top/bottom/right (1px or 0px) on an element with `border-radius`, browser layout engines distort the ellipse of the rounded corner. The curve stretches unevenly, producing a visible bulge or pinch at the top-left and bottom-left seams.
2. **Outdated Low-Effort Visual Language**: The single thick colored left border was an expedient pattern in early UI frameworks to indicate "active workspace" or "warning callout". In modern high-craft interfaces, this visual shortcut feels heavy, distracting, and dated.

#### The 3 Canonical Modern Alternatives:
```css
/* 1. RECOMMENDED: Uniform 1px border with subtle tonal background */
.r-ui-nav-item.is-active,
.r-ui-card--selected {
  border: 1px solid rgba(var(--r-ui-color-accent-primary-rgb), 0.35);
  background-color: rgba(var(--r-ui-color-accent-primary-rgb), 0.08);
  color: var(--r-ui-color-text-primary);
}

/* 2. DECOUPLED FLOATING PILL: When a directional vertical indicator is required */
.r-ui-nav-item-active-indicator {
  position: absolute;
  left: 6px;
  top: 50%;
  transform: translateY(-50%);
  width: 3px;
  height: 16px;
  border-radius: var(--r-ui-radius-full);
  background-color: var(--r-ui-color-accent-primary);
}

/* 3. OPTICAL 1PX INNER RING: When highlighting without expanding layout box */
.r-ui-card--highlighted {
  border: 1px solid var(--r-ui-color-border-standard);
  box-shadow: 0 0 0 1px var(--r-ui-color-accent-primary), var(--r-ui-shadow-xs);
}
```

---

## 13. COLOR SCIENCE & PALETTE ARCHITECTURE (The 60-30-10 Rule, Undertone Families, 9-Step Tonal Ramps & Semantic Feedback Harmony)

Color usage in world-class interfaces is not decorative seasoning, but **a precise optical hierarchy communication system**. Agents using `r-ui` must understand and apply color science:

```text
+-----------------------------------------------------------------------------------------+
|                         THE 60-30-10 SPATIAL COLOR FORMULA                              |
+------------------------------------+--------------------------------+-------------------+
| 60% DOMINANT FOUNDATION             | 30% STRUCTURAL SECONDARY       | 10% FOCAL ACCENT  |
| Canvas, Surfaces, Cards, Dialogs   | Hairlines, Borders, Subtitles  | Primary CTA, Ring |
| Unified Neutral Undertone Family   | Table Headers, Neutral Badges  | Active Tab, Dot   |
+------------------------------------+--------------------------------+-------------------+
```

### 13.1. The 60-30-10 Spatial Color Formula
1. **60% Dominant Neutral Foundation**: Covers canvas backdrops (`--r-ui-color-canvas`), surface panels (`--r-ui-color-surface`), and elevated cards (`--r-ui-color-surface-elevated`). This foundation provides a calm stage for content without visual noise.
2. **30% Structural Secondary & Boundaries**: 1px subtle hairlines (`--r-ui-color-border-subtle`), standard dividers (`--r-ui-color-border-standard`), secondary body text (`--r-ui-color-text-secondary`), hover backdrops, and neutral badges.
3. **10% Calibrated Focal Accent**: Primary action buttons (*primary CTA*), keyboard focus rings (*focus ring*), active tab indicators, and critical status pulses. **When everything is colorful, nothing stands out.**

### 13.2. The 4 Coherent Neutral Undertone Families
Never use raw gray `#808080` or dead black `#000000` without temperature. Select one consistent neutral undertone family:
- **Cool Slate (Hue 215°–225°)**: Tech, Cloud, DevOps, Network Security. Character: cool, analytical, precise (`#07090e` / `#0f1422`).
- **Neutral Zinc (Hue 240°, saturation 4–8%)**: Linear/Apple style, modern SaaS, minimalist workspaces. Character: balanced, clean, versatile (`#09090b` / `#141418`).
- **Warm Stone / Oat (Hue 35°–45°)**: Editorial, Luxury, Media Publishing, Lifestyle. Character: organic, warm, comfortable (`#0f0e0c` / `#faf8f5`).
- **OLED Obsidian (Hue 260°, saturation 2–4%)**: Creative Studios, AI Labs, Media Players. Character: deep, cinematic contrast (`#040405` / `#0d0e12`).
> **Anti-Dissonance Law**: Never mix different neutral undertones in the same layout (e.g. placing a warm stone card inside a cool slate canvas).

### 13.3. The 9-Step Tonal Ramp Architecture (50–950)
Every accent and neutral ramp adheres to a uniform lightness ladder:
- `50` & `100`: Ultra-subtle tints for hover backdrops and soft badges.
- `200` & `300`: Hairline borders and light mode interactive controls.
- `400` & `500`: Light mode primary accent and dark mode disabled text.
- `600` & `700`: Dark mode primary accent and hover/pressed states.
- `800` & `900`: Dark mode card surfaces and elevated containers.
- `950`: Deepest dark mode canvas foundation.

### 13.4. The Non-Neon Semantic Feedback Quartet
Feedback status must be crisp and instantly legible while remaining visually calm:
- **Success (Emerald Green)**: `--r-ui-color-success: #10b981;` with soft tint `rgba(16, 185, 129, 0.12)`.
- **Warning (Amber Honey)**: `--r-ui-color-warning: #f59e0b;` with soft tint `rgba(245, 158, 11, 0.12)`.
- **Error (Rose/Crimson Red)**: `--r-ui-color-error: #ef4444;` with soft tint `rgba(239, 68, 68, 0.12)`.
- **Info (Sky/Cyan Blue)**: `--r-ui-color-info: #0ea5e9;` with soft tint `rgba(14, 165, 233, 0.12)`.
> **Multi-Channel Principle**: Never rely solely on color to communicate status; always accompany with an icon or descriptive badge.

---

## 14. TYPOGRAPHIC COMPOSITION DOCTRINE (3-Tier Font Hierarchy, Modular Scaling, Leading Ratios, The Tracking Inversion Law & 3-Weight Discipline)

Typography accounts for 90% of user interface design. High-end typography is achieved through **mathematical modular scales, proportional leading ratios, and micro-tracking discipline**.

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

### 14.1. The 3-Tier Font Family Pairing Engine
1. **Tier 1 — Display & Brand Typography**: Establishes identity and geometric visual character (`Plus Jakarta Sans`, `Geist`, `Clash Display`, `Space Grotesk`). Used for H1, H2, and Hero headlines.
2. **Tier 2 — Interface & Body Typography**: Features high x-height, open apertures, and superior legibility at small sizes (`Geist Sans`, `Plus Jakarta Sans`, `Inter Display`, `Satoshi`). Used for forms, buttons, tables, and descriptive paragraphs.
3. **Tier 3 — Tabular & Monospace Typography (Data & Telemetry)**: Uniform glyph widths (*fixed pitch*) for statistics, comparative tables, audit logs, timestamps, and code (`JetBrains Mono`, `Geist Mono`, `SF Mono`).

### 14.2. Fluid Modular Scales (Clamp-Based Scaling)
Avoid arbitrary font sizes; use responsive `clamp()` formulas that adapt smoothly across viewports without jarring breakpoint jumps:
- **Hero Title**: `clamp(2.25rem, 1.5rem + 3.75vw, 4.25rem)` (36px–68px).
- **H1**: `clamp(1.85rem, 1.25rem + 2.5vw, 3rem)` (30px–48px).
- **H2**: `clamp(1.5rem, 1.15rem + 1.6vw, 2.25rem)` (24px–36px).
- **H3**: `clamp(1.25rem, 1.05rem + 1vw, 1.75rem)` (20px–28px).
- **Body Base**: `clamp(0.875rem, 0.85rem + 0.15vw, 1rem)` (14px–16px).
- **Caption / UI Label**: `0.8125rem` (13px).
- **Micro Badge / Eyebrow**: `0.6875rem`–`0.75rem` (11px–12px).

### 14.3. Leading Discipline (Line-Height Vertical Rhythm)
Line height must adapt inversely to font size:
1. **Large Headlines (Display & H1/H2)**: Leading **Tight (1.05–1.20)**. When large text uses loose leading, words fracture and appear visually disconnected.
2. **UI Controls, Form Inputs & Buttons**: Leading **Snug (1.25–1.35)**. Ensures text is optically centered vertically inside 36px–40px buttons and inputs without clipping accents or descenders.
3. **Paragraphs & Long-Form Reading**: Leading **Relaxed (1.50–1.65)** with line lengths bounded to `max-width: 65ch–72ch` to maintain smooth eye tracking across lines.

### 14.4. The Tracking Inversion Law (Letter-Spacing)
> **The Golden Law of Letter Spacing**:  
> *The larger the font size, the tighter the tracking. The smaller the font size, the wider the tracking.*
- **Large Headlines (>= 24px)**: Negative Tracking (`letter-spacing: -0.025em` to `-0.020em`). Binds large characters into solid, punchy words.
- **Normal Body Text (14px–18px)**: Neutral Tracking (`letter-spacing: 0` or `-0.005em`).
- **Micro-Labels & Eyebrow All-Caps (<= 12px)**: Positive Expanded Tracking (`letter-spacing: 0.05em` to `0.08em; text-transform: uppercase;`). Prevents small uppercase letters from fusing together into illegible ink-blobs.

### 14.5. Strict 3-Weight Discipline (Anti-Weight Explosion)
Never use more than 3 font weights on a single screen:
- `Regular (400)`: Body text, table data cells, long descriptions.
- `Medium (500)`: Form labels, table headers, navigation links, secondary buttons.
- `Semi-Bold / Bold (600 / 700)`: Primary titles, stat card metric values, primary action buttons.
> **Ban**: Mixing font weights 300, 400, 500, 600, 700, 800, 900 across the same interface.

### 14.6. The 3-Tier Text Luminance Contrast Hierarchy
- **Primary Text (100% legibility)**: Headlines, primary numerical values, active selected items (`--r-ui-color-text-primary`).
- **Secondary Text (65–70% contrast)**: Subtitles, input field labels, metadata keys (`--r-ui-color-text-secondary`).
- **Tertiary / Muted Text (45–50% contrast)**: Timestamps, placeholder hints, breadcrumb dividers, shortcuts (`--r-ui-color-text-tertiary`).

---

## 15. KINETIC PHYSICS & HAPTIC MICRO-INTERACTIONS (Designspells Delight & Kinetic Feedback)

Micro-interactions transform interfaces from static layouts into responsive physical instruments:

```text
+---------------------------------------------------------------------------------+
|                         KINETIC INTERACTION PROTOCOL                            |
+---------------------------------------------------------------------------------+
| 1. SPRING PHYSICS     ---> cubic-bezier(0.16, 1, 0.3, 1) timing curves          |
| 2. TACTILE CLICK      ---> scale(0.975) depression on mousedown / touch         |
| 3. STAGGERED CASCADE  ---> calc(index * 35ms) entrance delays on collections    |
| 4. MORPHING FEEDBACK  ---> Fluid icon transformation (Copy to Checkmark)        |
+---------------------------------------------------------------------------------+
```

### 15.1. Standard Haptic Click Depression
All buttons and interactive cards must implement active physical depression:
```css
.r-ui-btn:active,
.r-ui-card-interactive:active {
  transform: scale(0.975);
  transition: transform var(--r-ui-duration-instant) var(--r-ui-ease-spring-snappy);
}
```

### 15.2. Staggered Cascade Entrance
Collections, grids, and tables animate smoothly using index-based staggering:
```css
.r-ui-stagger-item {
  animation: rUiFadeSlideUp var(--r-ui-duration-normal) var(--r-ui-ease-spring-snappy) backwards;
  animation-delay: calc(var(--item-index, 0) * 35ms);
}
```

*Complete interaction specifications:* [r-ui-interaction-and-accessibility-spec.md](references/r-ui-interaction-and-accessibility-spec.md).

---

## 16. ACCESSIBILITY, FOCUS MANAGEMENT & KEYBOARD SPATIAL NAVIGATION (WCAG 2.2 AAA)

High-craft software guarantees complete keyboard autonomy and screen reader accessibility:

```text
+---------------------------------------------------------------------------------+
|                         KEYBOARD & ACCESSIBILITY TRIAD                          |
+---------------------------------------------------------------------------------+
| 1. DOUBLE-RING FOCUS   ---> 2px outline + 2px offset + 4px canvas shadow        |
| 2. ROVING TABINDEX     ---> Arrow-key navigation inside toolbars and tablists   |
| 3. ARIA LIVE REGIONS   ---> aria-live="polite" for dynamic telemetry and toasts |
+---------------------------------------------------------------------------------+
```

### 16.1. The Double-Ring Focus State (WCAG 2.2 AAA)
Never write `outline: none` without providing the calibrated double-ring focus replacement:
```css
:focus-visible {
  outline: 2px solid var(--r-ui-color-focus-ring) !important;
  outline-offset: 2px !important;
  box-shadow: 0 0 0 4px var(--r-ui-color-canvas) !important;
}
```

### 16.2. Roving Tabindex for Toolbars & Menus
Toolbars, segmented buttons, and tabs maintain a single `tabindex="0"` stop in the DOM flow. Inner items are navigated using `ArrowLeft` / `ArrowRight` or `ArrowUp` / `ArrowDown`.

---

## 17. COMPONENT STATE EXHAUSTIVENESS (The 6 Universal States & Edge Cases)

No component is declared complete until all **6 universal states** are formally defined:

```text
+---------------------------------------------------------------------------------+
|                        THE 6 UNIVERSAL COMPONENT STATES                         |
+-----------------+-----------------+-----------------+-------------+-------------+
| 1. IDLE         | 2. HOVER        | 3. ACTIVE/PRESS | 4. FOCUS    | 5. DISABLED |
| Base Rest State | Optical Lift    | Scale Depress   | Double-Ring | 40% Opacity |
+-----------------+-----------------+-----------------+-------------+-------------+
| 6. LOADING / SKELETON SHIMMER     ---> aria-busy="true" animated gradient pulse |
+---------------------------------------------------------------------------------+
```

- **Empty State Requirement**: Any data collection, table, or search result must include a designated empty state with an icon, explanatory title, resolution guidance, and clear primary CTA.
- **Form Error State**: Invalid inputs declare `.is-error` with semantic border color, error tint, and an accompanying message with icon (`role="alert"`).

*Complete interaction, accessibility & state specifications:* [r-ui-interaction-and-accessibility-spec.md](references/r-ui-interaction-and-accessibility-spec.md).

---

## 18. UNIFIED CANVAS & LINE-LESS WORKSPACE DOCTRINE (Seamless Master-Detail, Unified Title Bar & Border-Free Layout)

Modern pro-tier developer environments, creative suites, and AI workspaces (Linear, Raycast, Cursor, Antigravity, T-Line Desktop) have evolved beyond traditional boxy, heavily segmented desktop layouts. Instead of confining navigation, menus, and content into isolated, high-contrast bordered panels, they adopt a **Unified Canvas Architecture**:

```text
+---------------------------------------------------------------------------------------------------+
|                                 UNIFIED CANVAS & LINE-LESS WORKSPACE                              |
+---------------------------------------------------------------------------------------------------+
|  [Menu] [Breadcrumb / Workspace Location]                          [_] [□] [X]  <-- UNIFIED TITLE |
+---------------------------------------------------------------------------------------------------+
|  SIDEBAR / SESSION RAIL          |  PRIMARY WORKSPACE & CANVAS                                    |
|  - Muted secondary typography    |  - High-contrast active stage                                  |
|  - Zero hard border-right divider|  - Proportional 4pt/8pt negative space                         |
|  - Soft-tint interactive hover   |  - Full-bleed monolithic canvas surface                        |
|  - Flush with main canvas        |                                                                |
|                                  |        +---------------------------------------------+         |
|                                  |        |  (•) Floating Island / Action Prompt Dock   |         |
|                                  |        +---------------------------------------------+         |
+----------------------------------+----------------------------------------------------------------+
```

### 18.1. Monolithic Canvas & Line-less Split View (Anti-Boxy Architecture)
- **The Visual Defect of Legacy Boxy Layouts**: Placing high-contrast vertical line dividers (`border-right: 1px solid #333` or 2px beveled splitters) between the sidebar and the main content creates visual claustrophobia. It partitions the screen into rigid visual cages and distracts the eye.
- **The Monolithic Canvas Principle**: The sidebar (navigation/session history) and the primary workspace share the **exact same root canvas surface background** (`--r-ui-color-canvas` / `--background`) or an ultra-subtle tonal delta (less than 2% luminance shift).
- **Zero Hard Vertical Divider**: Remove rigid full-height `border-right` dividers between master (sidebar) and detail (workspace). Visual division is achieved entirely through **Gestalt Proximity**, **Negative Space**, and **Luminance Contrast Hierarchy**.

### 18.2. Unified Title Bar & Client-Side Decoration (CSD / Extended Title Bar)
Traditional desktop interfaces waste valuable vertical real estate by stacking an OS title bar, an application menu bar, and a navigation bar into 3 separate vertical tiers (consuming 90px–120px).
- **The Unified Header Standard**: Merge the Menu Bar (`Window`, `File`, `View`), Breadcrumb Trail / Current Context (`workspace / task / file`), and Window Controls (`Minimize`, `Maximize`, `Close`) into a **single 36px–42px unified header row**.
- **Cross-Platform Implementation**:
  - *Electron / Tauri / Desktop*: Utilize `titleBarStyle: 'hidden'` with inset traffic lights/controls or custom client-side window buttons.
  - *Web & SaaS Workspaces*: Position breadcrumbs, workspace selectors, and top-level menu triggers inline within the master header strip.
  - *Vertical Space Conservation*: Returns 30px–60px of vertical working room directly to the user's primary focus area.

### 18.3. Floating Action & Input Dock (Capsule Island Architecture)
Rather than pinning input bars and primary action strips rigidly against the bottom edge of the viewport with a full-width border-top divider:
- **Detached Floating Dock**: Elevate primary command inputs, chat prompts, or batch actions into a floating pill/capsule dock centered horizontally over the canvas.
- **Craft Constraints**:
  - Bound width proportionally (`max-width: 640px` to `768px`).
  - Use a subtle backdrop blur (`backdrop-filter: blur(8px)`), a crisp 1px hairline border (`border: 1px solid var(--r-ui-color-border-standard)`), and micro-elevation (`box-shadow: 0 4px 20px rgba(0, 0, 0, 0.15)`).
  - Provide comfortable bottom clearance (`margin-bottom: 24px` to `32px`) so content can breathe beneath it.

### 18.4. How to Separate Navigation and Workspace Without Lines
When border dividers are eliminated, layout clarity is maintained through 3 strict optical rules:
1. **Typographic Luminance Contrast**:
   - Sidebar item labels and metadata use secondary/muted luminance (`--r-ui-color-text-secondary` or `--r-ui-color-text-tertiary`, 50%–65% contrast).
   - Main workspace headings and active editor text use primary luminance (`--r-ui-color-text-primary`, 100% legibility).
2. **Negative Space Gutters (Gestalt Continuity)**:
   - Enforce an uninterrupted vertical column gap (`padding: 16px` to `24px`) between the rightmost edge of sidebar text and the leftmost edge of workspace content.
3. **Soft-Tint Interactive Surfaces**:
   - Hover and selected states in the sidebar use gentle translucent tint fills (`rgba(var(--r-ui-color-accent-primary-rgb), 0.08)` or subtle surface highlights) with uniform 1px border or decoupled pill indicators, preserving seamless boundary integration.

---

## 19. ON-DEMAND BESPOKE SVG ICON CRAFTING DOCTRINE (Zero-Dependency Just-In-Time Iconography)

Rather than installing bloated third-party icon packages (Lucide, FontAwesome, Heroicons) that introduce hundreds of unused glyphs and lack project-specific domain iconography, agents and developers using `r-ui` **MUST CRAFT BESPOKE SVG ICONS ON-DEMAND** according to the exact functional needs of the interface being built.

```text
+---------------------------------------------------------------------------------------------------+
|                        ON-DEMAND BESPOKE SVG ICON CRAFTING PROTOCOL                               |
+---------------------------------------------------------------------------------------------------+
| 1. THE 24×24 OPTICAL GRID  ──► 2px exterior margin; 20×20px live drawing bounds                   |
| 2. UNIFORM 1.5PX STROKE    ──► stroke-width: 1.5; stroke-linecap: round; integer coordinate snap  |
| 3. 100% CURRENTCOLOR       ──► Zero rogue hex; inherits text color & responds to active theme     |
| 4. ZERO NEON BLUR SLOP     ──► Ban <filter>, drop-shadow blur inside SVG; clean vectors only      |
| 5. MULTI-CHANNEL SEMANTICS ──► Never convey status by color alone; pair with semantic icon glyph  |
| 6. WCAG 2.2 AAA ACCESSIBLE ──► aria-hidden="true" on decorative; aria-label on interactive button |
+---------------------------------------------------------------------------------------------------+
```

### 19.1. Anti-Third-Party Icon Bloat Mandate
1. **Zero External Icon Libraries**: Never install external NPM icon packages for a few simple buttons or navigation items.
2. **Context-Driven Just-In-Time Crafting**: Craft only the exact SVG glyphs needed by the component. If a component needs a search trigger, write an inline `<svg>` with a clean lens and stem. If an AI status bar needs a token gauge, craft an authentic 24×24 gauge path directly.
3. **No Decorative Clutter**: Do not sprinkle random icons purely as visual noise. Every icon must serve a distinct navigational, semantic, or action purpose.

### 19.2. The 24×24 Optical Grid & Geometry Standard
- **Primary Canvas**: `viewBox="0 0 24 24"`.
- **Live Drawing Area**: $20 \times 20\text{px}$ bounded between $x \in [2, 22]$ and $y \in [2, 22]$ (2px outer margin).
- **Micro / Tabular Variant**: `viewBox="0 0 16 16"` with 1px outer margin and `stroke-width="1.75"` or `2.0`.
- **Stroke Uniformity**: `stroke-width="1.5"`, `stroke-linecap="round"`, `stroke-linejoin="round"`, `fill="none"`.
- **Pixel Snapping**: Coordinate points must be integers or exact half-pixels (`0.5`) to eliminate anti-aliasing fuzziness.

### 19.3. 100% Theme Reactivity Contract (`currentColor`)
- **No Rogue Hex in Vectors**: Never write `stroke="#38bdf8"` or `fill="#000000"` inside an SVG path.
- **Inherited Chromatic Harmony**: Always set `stroke="currentColor"` (and `fill="currentColor"` for duotone or solid elements). When a user switches between `dark-nebula`, `clean-light`, or any accent theme (`cyan`, `emerald`, `crimson`), the icon automatically inherits the container's typography or accent tokens without manual CSS overrides.

### 19.4. Zero-Dependency Inline Component Wrapper
When writing components, use this lightweight inline wrapper pattern:
```tsx
const RUiIcon = ({ size = 20, label, children, ...props }) => (
  <svg
    viewBox="0 0 24 24"
    width={size}
    height={size}
    fill="none"
    stroke="currentColor"
    strokeWidth="1.5"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden={!label}
    role={label ? "img" : "presentation"}
    focusable="false"
    style={{ display: "inline-block", verticalAlign: "middle", flexShrink: 0 }}
    {...props}
  >
    {label && <title>{label}</title>}
    {children}
  </svg>
);
```

### 19.5. On-Demand Geometric Primitives Reference
- *Chevron Down*: `<path d="m6 9 6 6 6-6" />`
- *Arrow Right*: `<path d="M5 12h14M12 5l7 7-7 7" />`
- *Search*: `<circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" />`
- *Close*: `<path d="M18 6 6 18M6 6l12 12" />`
- *Checkmark*: `<path d="M5 13l4 4L19 7" />`
- *Terminal*: `<path d="m4 17 6-6-6-6M12 19h8" />`
- *Pulse Activity*: `<path d="M22 12h-4l-3 9L9 3l-3 9H2" />`
- *Warning Triangle*: `<path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3ZM12 9v4M12 17h.01" />`

### 19.6. Kinetic Micro-Interactions & State Morphing (Designspells Delight)
- **Haptic Pop & Draw**: Pair success states (like copying tokens) with a tactile scale pop `scale(1.15)` and self-drawing stroke animation (`stroke-dashoffset`).
- **Center-Axis Spring Rotation**: Animate disclosure chevrons using `transform-origin: 12px 12px; transform: rotate(180deg)` with spring physics `cubic-bezier(0.16, 1, 0.3, 1)` (180ms–240ms duration) to eliminate layout jitter.
- **Dynamic Masking & Radar Pulses**: Support live status telemetry with expanding radar ripple rings and animated secret reveal lines.

*Complete on-demand recipes, kinetic morphing kit & optical balance guide:* [r-ui-on-demand-icon-crafting.md](references/r-ui-on-demand-icon-crafting.md).

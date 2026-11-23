---
name: curated-design-references
description: "Authoritative design references guide for AI agents: jiro.build (1,400+ designs via MCP), designspells.com (micro-interactions), styles.refero.design (real color and type systems), supahero.io (hero sections), and mobbin.com (real app flows via MCP). Use whenever designing, building, or reviewing UI/UX, frontend components, and user flows."
---

# Curated Design References for AI Coding Agents

> Stop guessing UI designs, defaulting to purple gradients, and producing generic AI slop.
> Ground all UI/UX decisions in production-tested, real-world design systems and battle-tested references.

---

## The 5 Essential Reference Anchors

Whenever designing, implementing, or reviewing frontend interfaces, consult and apply these 5 reference pillars:

```
+-----------------------------------------------------------------------------------------+
|                                CURATED DESIGN REFERENCES                                |
+-----------------------+-----------------------------+-----------------------------------+
| Reference             | Domain Focus                | Integration & Transport           |
+-----------------------+-----------------------------+-----------------------------------+
| 1. jiro.build         | 1,400+ Component Designs    | MCP: `jiro` (https://mcp.jiro.build) |
| 2. designspells.com   | Micro-Interactions & Craft  | Web / Direct Reference Concept     |
| 3. styles.refero.design| Real Color & Type Systems  | Design Tokens & Typographic Scales|
| 4. supahero.io        | Hero Section Architectures  | High-Impact Above-the-Fold Layouts|
| 5. mobbin.com         | Real-World App Flows        | MCP: `mobbin` & Official Plugin   |
+-----------------------+-----------------------------+-----------------------------------+
```

---

## 1. Jiro (`jiro.build`) — 1,400+ Modular Designs via MCP

* **Primary Purpose**: Rapid retrieval of pre-designed, production-ready website sections, modern Bento blocks, headers, pricing tables, and footer layouts.
* **MCP Configuration**: Remote Streamable HTTP endpoint configured in `~/.gemini/config/mcp_config.json`:
  ```json
  "jiro": {
    "url": "https://mcp.jiro.build"
  }
  ```
* **When to Reach for It**:
  - When the user asks for a new landing page section (feature grid, pricing cards, testimonial carousels, FAQ accordions).
  - When seeking structured design prompts that bypass generic LLM habits.
  - To pull tested component layouts directly into the active codebase.

---

## 2. Design Spells (`designspells.com`) — Micro-Interactions & Crafted Delight

* **Primary Purpose**: Micro-animations, subtle delight moments, tactile feedback, and interactive physics that make software feel alive.
* **Key Patterns to Apply**:
  - **Magnetic Buttons & Links**: Micro-pull towards the cursor (`framer-motion` / `motion/react` spring physics).
  - **Fluid Stateful Toggles**: Smooth spring transitions when toggling states, switching themes, or selecting tabs.
  - **Contextual Cursor Cues**: Changing cursor state (view, expand, drag) when hovering interactive viewports or carousels.
  - **Tactile Inputs**: Instant visual confirmation upon focus, copy-to-clipboard badges with morphing checkmarks, floating labels with zero layout shift.
  - **Delightful Transitions**: Staggered fades, subtle scale punches (`scale: 0.98` on click), and bouncy entrance animations.

---

## 3. Styles Refero (`styles.refero.design`) — Real Color & Type Systems

* **Primary Purpose**: Real-world color palettes, tonal ramps, and typographic pairings audited directly from leading tech and consumer products.
* **Anti-Slop Color Rules**:
  - **Ban Generic Palettes**: NEVER default to standard Indigo-600 / Purple-500 gradients on dark-slate backgrounds.
  - **Grounding in Real Products**: Extract calibrated color tokens (neutral base, deep semantic borders, calibrated brand accents).
  - **High-Contrast Text**: Strict compliance with WCAG AA (minimum 4.5:1 for body copy, 3:1 for large text).
* **Typographic Hierarchy**:
  - Pair distinct editorial or geometric display typefaces (e.g., Geist, Inter Display, Fraunces, Space Grotesk, Plus Jakarta Sans) with rock-solid sans body fonts.
  - Establish a tight mathematical modular scale (e.g., 1.250 Major Third or 1.333 Perfect Fourth) for fluid typography.

---

## 4. Supahero (`supahero.io`) — Hero Sections & Above-the-Fold Architecture

* **Primary Purpose**: High-converting, impactful above-the-fold structures for marketing, SaaS, portfolio, and e-commerce websites.
* **Hero Section Archetypes**:
  - **Asymmetric Split**: Powerful headline + social proof on one side, live interactive demo or high-resolution UI preview on the other.
  - **Editorial Manifesto**: Oversized typography with high typographic rhythm, minimal asset clutter, and prominent primary action.
  - **Layered UI Mockup**: Angled or floating product preview with backdrop glow and depth layering.
  - **Video / Media Mask**: Dynamic video or particle background masked cleanly behind high-contrast text.
* **Layout Discipline**:
  - Always use `min-h-[100dvh]` or `min-h-screen` with defensive padding rather than hardcoded `h-screen`.
  - Place primary CTA and value proposition strictly within the initial viewport fold.

---

## 5. Mobbin (`mobbin.com`) — Real App Flows & Comprehensive UX Journeys

* **Primary Purpose**: Exhaustive library of real-world screens and multi-step user flows across top iOS, Android, and Web applications.
* **MCP Configuration**: Remote Streamable HTTP endpoint configured in `~/.gemini/config/mcp_config.json`:
  ```json
  "mobbin": {
    "url": "https://api.mobbin.com/mcp"
  }
  ```
  *(Also available as the official Antigravity plugin: `antigravity-plugins-partners/plugin/mobbin`).*
* **When to Reach for It**:
  - Designing full product user flows: Onboarding wizards, checkout flows, payment gateway screens, paywalls, profile settings, and complex filter modals.
  - Verifying edge cases in real products: Empty states, error states, permission modals, and loading skeletons.
  - Ensuring the user experience adheres to battle-tested conventions rather than speculative workflows.

---

## Execution Workflow for Frontend Tasks

Whenever tasked with frontend or UI/UX implementation:

1. **Query MCP Assets**:
   - Check `jiro` MCP tools for matching section templates or component structures.
   - Check `mobbin` MCP tools for end-to-end user flow references and state progressions.
2. **Consult Style Foundations**:
   - Cross-check `styles.refero.design` for cohesive color palette and font pairing choices.
   - Cross-check `supahero.io` if building or refactoring hero sections.
3. **Inject Micro-Interactions**:
   - Apply `designspells.com` principles for hover states, button feedback, and spring animations.
4. **Validate against Anti-Slop**:
   - Pass through `/antislop` and `/design-taste-frontend` rules before finishing.

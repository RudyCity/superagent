# r-ui: Modular Component Architecture & Consistency Engine

Operational guide for the atomic and compound modular component architecture (*Atomic & Compound Component System*) to ensure 100% visual and interaction consistency across all product features and views.

---

## 1. The 5-Tier Modular Atomic Hierarchy

Every interface element within the `r-ui` ecosystem is categorized into 5 structured tiers:

```text
+---------------------------------------------------------------------------------+
|                      r-ui MODULAR ATOMIC HIERARCHY                              |
+---------------------------------------------------------------------------------+
|  Layer 1: DESIGN TOKENS   ---> r-ui-tokens.css (--r-ui-* variables)             |
|  Layer 2: ATOMS           ---> Button, Input, Badge, Avatar, IconBox, Text      |
|  Layer 3: MOLECULES       ---> FieldGroup, SearchBar, StatCard, ToastItem       |
|  Layer 4: ORGANISMS       ---> Navbar, BentoGrid, AdaptiveModal, DataSheet      |
|  Layer 5: TEMPLATES/VIEWS ---> DashboardView, OnboardingFlow, SettingsPage      |
+---------------------------------------------------------------------------------+
```

### Layer Rules:
1. **Layer 1: Design Tokens**: Pure variable foundations (Color, 4pt/8pt Spacing, Radius, Typography, Easing). Writing raw CSS values without referencing tokens is strictly banned.
2. **Layer 2: Atoms**: The smallest indivisible building blocks. Business-logic-free and completely state-agnostic.
3. **Layer 3: Molecules**: Combinations of 2 or more Atoms working together (e.g. Label + Input + ErrorMessage = `FieldGroup`).
4. **Layer 4: Organisms**: Self-contained, complex UI blocks (e.g. Navigation Header with logo, menu items, profile avatar, and command palette trigger).
5. **Layer 5: Templates/Views**: Complete page layouts orchestrating Organisms into end-to-end user journeys.

---

## 2. The 4 Iron Laws of Component Consistency

To prevent design fragmentation during continuous feature expansion:

### Law 1: Zero Magic Numbers (Strict Token Discipline)
- ❌ **Banned**: Writing `padding: 13px`, `margin: 27px`, `color: #4a5b6c`, or `transition: 0.25s ease`.
- ✅ **Mandatory**: Using registered design tokens: `padding: var(--r-ui-space-3)`, `color: var(--r-ui-color-text-secondary)`, `transition: var(--r-ui-duration-fast) var(--r-ui-ease-spring)`.

### Law 2: Uniform Prop Signatures (Consistent Property Contracts)
All Atoms and Molecules must share identical prop naming conventions:
- **`variant`**: Determines visual hierarchy (`primary`, `secondary`, `ghost`, `destructive`, `outline`).
- **`size`**: Determines dimensional scale (`sm`, `md`, `lg`).
- **`intent`**: Determines semantic feedback (`default`, `info`, `success`, `warning`, `error`).
- **`state`**: Determines interactive state (`idle`, `loading`, `disabled`).

### Law 3: Composition Over Boolean Props Explosion
Avoid monolithic components riddled with dozens of boolean flags (`hasIcon`, `isLeftIcon`, `isSearch`, `withBorder`).
- Use **Slots** or **Compound Components**:
  ```tsx
  // ✅ Recommended Modular Composition
  <FieldGroup>
    <FieldGroup.Label>Email Address</FieldGroup.Label>
    <FieldGroup.Input type="email" placeholder="name@company.com" />
    <FieldGroup.Hint>We will never share your email address.</FieldGroup.Hint>
  </FieldGroup>
  ```

### Law 4: Headless Logic & Presentation Separation
Decouple interactive state (such as modal open/close, tab index, or filter query) from visual presentation, enabling clean logic reuse across web, desktop, and mobile viewports.

---

## 3. Reusable Component Verification Checklist

Before certifying any component as ready for production:
- [ ] 1. **Token Compliance**: 100% of CSS properties reference `--r-ui-*` tokens.
- [ ] 2. **Theme Agnostic**: Automatically adapts when switching themes via `[data-r-ui-theme]`.
- [ ] 3. **Accessibility**: Declares proper ARIA attributes (`aria-expanded`, `aria-selected`, `aria-invalid`).
- [ ] 4. **Keyboard & D-Pad Friendly**: Navigable via `Tab`, `Enter`, `Space`, and arrow keys.
- [ ] 5. **Touch Ergonomics**: Touch hit-targets meet 44px–48px minimum on mobile viewports.
- [ ] 6. **Reduced Motion**: Disables or simplifies animations when `prefers-reduced-motion` is active.

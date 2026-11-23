# r-ui Interaction Physics, Accessibility & State Exhaustiveness Specification (v3.0.0)

> **Namespace**: `--r-ui-*`  
> **Standard**: WCAG 2.2 AAA, WAI-ARIA 1.2, Design Spells Micro-Interactions, 60fps GPU Hardware Acceleration.

---

## ⚡ PART 1: KINETIC PHYSICS & MICRO-INTERACTION ENGINE

Micro-interactions are the heartbeat of high-craft software. They transform static screens into responsive physical instruments.

```text
+-----------------------------------------------------------------------------------------+
|                         THE 4 KINETIC MOTION ARCHETYPES                                 |
+----------------------+----------------------+---------------------+---------------------+
| 1. SNAPPY SPRING     | 2. GENTLE FLOAT      | 3. TACTILE CLICK    | 4. MAGNETIC PULL    |
| (180ms - 220ms)      | (280ms - 350ms)      | (100ms - 140ms)     | (200ms - 300ms)     |
| Buttons, Dropdowns   | Drawers, Modals      | Active State Press  | Floating Actions    |
| cubic-bezier(0.16,1) | cubic-bezier(0.25,1) | cubic-bezier(0.4,1) | cubic-bezier(0.2,1) |
+----------------------+----------------------+---------------------+---------------------+
```

### 1.1. Calibrated Spring Curves & Timing Tokens

All motion in `r-ui` simulates real-world mass, damping, and surface friction:

```css
:root {
  /* Motion Physics Curves */
  --r-ui-ease-spring-snappy: cubic-bezier(0.16, 1, 0.3, 1);     /* Interactive controls */
  --r-ui-ease-spring-gentle: cubic-bezier(0.25, 1, 0.5, 1);     /* Overlays, drawers */
  --r-ui-ease-spring-bouncy: cubic-bezier(0.34, 1.56, 0.64, 1); /* Badges, alerts, delight */
  --r-ui-ease-spring-exit:   cubic-bezier(0.7, 0, 0.84, 0);     /* Dismissals, popover closing */

  /* Timing Steps */
  --r-ui-duration-instant: 100ms; /* Click depressions, checkbox checks */
  --r-ui-duration-fast:    180ms; /* Dropdown popovers, hover transitions */
  --r-ui-duration-normal:  260ms; /* Modal dialogs, toast entries */
  --r-ui-duration-slow:    380ms; /* Large slide-over inspector drawers */
}
```

### 1.2. The Tactile Click Depression (Haptic Simulation)

Buttons and interactive cards must feel physical under click or touch:

```css
.r-ui-btn,
.r-ui-card-interactive {
  transition: transform var(--r-ui-duration-instant) var(--r-ui-ease-spring-snappy),
              background-color var(--r-ui-duration-fast) ease,
              border-color var(--r-ui-duration-fast) ease,
              box-shadow var(--r-ui-duration-fast) ease;
  will-change: transform;
}

/* Micro-press on active click */
.r-ui-btn:active,
.r-ui-card-interactive:active {
  transform: scale(0.975);
}

/* Trailing icon kinetic shift on hover */
.r-ui-btn:hover .r-ui-icon-trailing {
  transform: translateX(2px);
  transition: transform var(--r-ui-duration-fast) var(--r-ui-ease-spring-snappy);
}
```

### 1.3. Staggered Entrance Choreography

When loading collections of cards, list items, or table rows, never animate them as a single monolithic block. Apply staggered cascade delays:

```css
.r-ui-stagger-item {
  animation: rUiFadeSlideUp var(--r-ui-duration-normal) var(--r-ui-ease-spring-snappy) backwards;
  animation-delay: calc(var(--item-index, 0) * 35ms);
}

@keyframes rUiFadeSlideUp {
  from {
    opacity: 0;
    transform: translateY(8px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}
```

### 1.4. Morphing Feedback Indicators

When users copy an API key, commit hash, or token, the icon must morph fluidly into a checkmark:

```css
.r-ui-copy-btn .r-ui-icon-check {
  display: none;
}

.r-ui-copy-btn.is-copied .r-ui-icon-copy {
  display: none;
}

.r-ui-copy-btn.is-copied .r-ui-icon-check {
  display: inline-block;
  animation: rUiScalePunch var(--r-ui-duration-fast) var(--r-ui-ease-spring-bouncy);
}

@keyframes rUiScalePunch {
  0%   { transform: scale(0.6); opacity: 0; }
  60%  { transform: scale(1.15); }
  100% { transform: scale(1); opacity: 1; }
}
```

---

## ♿ PART 2: ACCESSIBILITY, FOCUS & KEYBOARD NAVIGATION (WCAG 2.2 AAA)

Every interface must be 100% operable without a mouse, fully compatible with screen readers, and legible in high-contrast environments.

```text
+-----------------------------------------------------------------------------------------+
|                         ACCESSIBILITY & KEYBOARD TRIAD                                  |
+-------------------------------+-------------------------------+-------------------------+
| 1. DOUBLE-RING FOCUS          | 2. ROVING TABINDEX            | 3. ARIA LIVE REGIONS    |
| 2px Offset Outline + 4px Gap  | Arrow-Key Spatial Navigation  | Dynamic Telemetry &     |
| Zero Outline-None Violations  | Escape Dismissal & Focus Traps| Toast Announcements     |
+-------------------------------+-------------------------------+-------------------------+
```

### 2.1. The Calibrated Double-Ring Focus State

Never write `outline: none` without providing a superior replacement. `r-ui` enforces the **Double-Ring Focus Architecture**:

```css
/* Universal Focus-Visible Standard (WCAG 2.2 AAA Compliant) */
:focus-visible {
  outline: 2px solid var(--r-ui-color-focus-ring) !important;
  outline-offset: 2px !important;
  box-shadow: 0 0 0 4px var(--r-ui-color-canvas) !important;
  transition: outline-offset var(--r-ui-duration-instant) var(--r-ui-ease-spring-snappy);
}

/* Mouse click does NOT trigger focus ring; keyboard navigation does */
:focus:not(:focus-visible) {
  outline: none;
  box-shadow: none;
}
```

### 2.2. The Roving Tabindex Pattern (Composite Widgets)

Toolbars, tablists, segmented controls, and menu bars must only have **one tab stop** in the document flow. Internal items are navigated via arrow keys:

```text
Document Tab Flow:  [ Previous Input ] ---> [ Active Tab (tabindex=0) ] ---> [ Next Input ]
                                                        |
                                          ArrowLeft / ArrowRight
                                                        v
                                             [ Other Tabs (tabindex=-1) ]
```

```javascript
// Roving Tabindex Navigation Engine
function attachRovingTabindex(containerEl, selector) {
  const items = Array.from(containerEl.querySelectorAll(selector));
  if (items.length === 0) return;

  containerEl.addEventListener('keydown', (e) => {
    const currentIndex = items.indexOf(document.activeElement);
    if (currentIndex === -1) return;

    let nextIndex = currentIndex;
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
      e.preventDefault();
      nextIndex = (currentIndex + 1) % items.length;
    } else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
      e.preventDefault();
      nextIndex = (currentIndex - 1 + items.length) % items.length;
    } else if (e.key === 'Home') {
      e.preventDefault();
      nextIndex = 0;
    } else if (e.key === 'End') {
      e.preventDefault();
      nextIndex = items.length - 1;
    }

    if (nextIndex !== currentIndex) {
      items[currentIndex].setAttribute('tabindex', '-1');
      items[nextIndex].setAttribute('tabindex', '0');
      items[nextIndex].focus();
    }
  });
}
```

### 2.3. Modal & Drawer Focus Trapping

When an overlay (Modal or Drawer) opens:
1. Save the trigger element: `previousActiveElement = document.activeElement;`.
2. Move focus immediately to the first focusable element inside the modal.
3. Trap `Tab` navigation strictly within the modal container.
4. On `Escape` press, close the modal and immediately restore focus to `previousActiveElement`.

### 2.4. ARIA Live Regions for Streaming Telemetry

In dashboards with real-time logs, live metric counters, or toast notifications:

```html
<!-- For Notifications / Toasts (Reads when user is idle) -->
<div aria-live="polite" aria-atomic="true" class="r-ui-toast-region"></div>

<!-- For Critical Alerts / Disconnects (Interrupts immediately) -->
<div aria-live="assertive" role="alert" class="r-ui-alert-region"></div>

<!-- For Live Log Streams -->
<div aria-live="off" class="r-ui-terminal-stream">
  <!-- Status changes announced via polite summary badge -->
  <span class="sr-only" aria-live="polite">Streaming 142 lines per second</span>
</div>
```

---

## 🎛️ PART 3: THE 6 MANDATORY COMPONENT STATES & EDGE CASES

No component is production-ready until all **6 universal states** are formally defined:

```text
+-----------------------------------------------------------------------------------------+
|                         THE 6 UNIVERSAL COMPONENT STATES                                |
+-----------------+-----------------+-----------------+-------------+-------------+-------+
| 1. IDLE         | 2. HOVER        | 3. ACTIVE/PRESS | 4. FOCUS    | 5. DISABLED | 6. LOAD|
| Base Token Rest | Optical Lift    | Scale Depress   | Double-Ring | 40% Opacity | Shimmer|
+-----------------+-----------------+-----------------+-------------+-------------+-------+
```

### 3.1. Complete State Implementation Matrix

| State | Trigger Condition | Visual Appearance | Accessibility Flag |
| :--- | :--- | :--- | :--- |
| **1. Idle** | Default at rest | Clean base token surface, subtle 1px border | Normal |
| **2. Hover** | Mouse over control | Elevated background, border tint, cursor pointer | `:hover` |
| **3. Active** | Mouse click / Touch hold | `transform: scale(0.975)`, pressed surface fill | `:active` |
| **4. Focus-Visible** | Keyboard Tab navigation | 2px focus ring with 2px offset | `:focus-visible` |
| **5. Disabled** | `disabled` attribute | `opacity: 0.42`, `cursor: not-allowed`, no hover | `aria-disabled="true"` |
| **6. Loading** | `aria-busy="true"` | Spinner replace / skeleton shimmer, clicks blocked | `aria-busy="true"` |

### 3.2. Empty State Pattern Specification

When datasets return zero results:
```html
<div class="r-ui-empty-state">
  <div class="r-ui-empty-icon" aria-hidden="true">
    <!-- Clean, monoline SVG icon -->
  </div>
  <h3 class="r-ui-empty-title">No clusters found</h3>
  <p class="r-ui-empty-desc">There are no edge clusters matching your current filter parameters.</p>
  <div class="r-ui-empty-actions">
    <button class="r-ui-btn r-ui-btn-secondary" onclick="resetFilters()">Clear Filters</button>
    <button class="r-ui-btn r-ui-btn-primary" onclick="createCluster()">+ Create Cluster</button>
  </div>
</div>
```

### 3.3. Error Boundary & Form Validation States

Form inputs in an invalid state must clearly articulate errors across multiple sensory channels:
```css
.r-ui-input.is-error {
  border-color: var(--r-ui-color-error) !important;
  background-color: var(--r-ui-color-error-bg) !important;
}

.r-ui-input.is-error:focus-visible {
  outline-color: var(--r-ui-color-error) !important;
}

.r-ui-field-error-msg {
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: var(--r-ui-font-micro);
  color: var(--r-ui-color-error);
  margin-top: 4px;
}
```

---

## 📋 INTERACTION & ACCESSIBILITY AUDIT CHECKLIST

Before releasing an interface or component:
- [ ] **Spring Curves**: All transitions utilize calibrated cubic-bezier curves (no linear/ease-in-out).
- [ ] **Tactile Press**: Buttons and interactive cards feature micro-scale depression (`scale(0.975)`).
- [ ] **Double-Ring Focus**: All interactive controls declare high-contrast 2px focus-visible rings with 2px offsets.
- [ ] **Zero Outline-None**: No CSS rule contains `outline: none` without `:focus-visible` replacement.
- [ ] **Keyboard Roving Tabindex**: Toolbars and segmented tabs navigate via arrow keys with single tab stops.
- [ ] **Focus Trapping**: Overlays (modals/drawers) trap focus and release it cleanly to the trigger on Escape.
- [ ] **All 6 States Defined**: Idle, Hover, Active, Focus, Disabled, and Loading states are visually distinct.
- [ ] **ARIA Live Regions**: Dynamic asynchronous updates (toasts, logs) announce changes to screen readers.
- [ ] **Prefers Reduced Motion**: Animations degrade gracefully to instantaneous cuts when motion reduction is requested.

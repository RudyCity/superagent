# r-ui: Universal Multi-Device Responsive Matrix & Recipes

Production implementation guide for universal responsiveness across platforms: **Web & PWA**, **Desktop OS (Windows, macOS, Linux)**, **Mobile & Tablet (Android, iOS)**, **Foldables**, and **Smart TV (10-Foot UI)**. 100% original intellectual property.

---

## 1. Web & Progressive Web Apps (PWA)

### A. Safari / iOS Rubber-Banding Elimination
```css
/* Prevent unwanted rubber-band bounce on nested containers */
.r-ui-scroll-surface {
  overflow-y: auto;
  overscroll-behavior-y: contain;
  -webkit-overflow-scrolling: touch;
}
```

### B. Dynamic Viewport Height (100vh Bug Elimination)
```css
/* 100vh on mobile browsers is frequently obscured by dynamic address bars */
.r-ui-screen-fill {
  min-height: 100dvh;
  height: 100svh; /* Fallback small viewport */
}
```

### C. Standalone PWA Adaptation
```css
/* Detection when app is launched in standalone installed mode (PWA) */
@media (display-mode: standalone) {
  .r-ui-header {
    padding-top: max(var(--r-ui-space-4), env(safe-area-inset-top));
    border-top: none;
  }
  .r-ui-pwa-only {
    display: flex;
  }
}
```

---

## 2. Desktop OS Matrix: Windows, macOS, Linux

### A. Windows Modern Non-Intrusive Scrollbars
```css
/* W3C standard & WebKit engine for Windows fractional DPI */
* {
  scrollbar-width: thin;
  scrollbar-color: var(--r-ui-color-border-strong) transparent;
}

::-webkit-scrollbar {
  width: 6px;
  height: 6px;
}
::-webkit-scrollbar-track {
  background: transparent;
}
::-webkit-scrollbar-thumb {
  background: var(--r-ui-color-border-standard);
  border-radius: var(--r-ui-radius-full);
}
::-webkit-scrollbar-thumb:hover {
  background: var(--r-ui-color-border-strong);
}
```

### B. macOS Retina Typography Smoothing & Surface Vibrancy
```css
body {
  -webkit-font-smoothing: antialiased;
  -moz-osx-font-smoothing: grayscale;
  text-rendering: optimizeLegibility;
}

.r-ui-vibrancy-panel {
  background: rgba(18, 20, 28, 0.75);
  backdrop-filter: blur(20px) saturate(180%);
  -webkit-backdrop-filter: blur(20px) saturate(180%);
  border: 1px solid var(--r-ui-color-border-subtle);
}
```

### C. Precision Pointer vs Coarse Touch Separation
```css
/* Only enable hover effects if device utilizes precision mouse/pointer */
@media (hover: hover) and (pointer: fine) {
  .r-ui-interactive-item:hover {
    transform: translateY(-2px);
    box-shadow: var(--r-ui-shadow-md);
    border-color: var(--r-ui-color-border-strong);
  }
}

/* For touchscreens: disable floating hover, replace with active state */
@media (hover: none) and (pointer: coarse) {
  .r-ui-interactive-item:active {
    transform: scale(0.98);
    background: var(--r-ui-color-surface-pressed);
  }
}
```

---

## 3. Mobile & Tablet Ergonomics (Android & iOS)

### A. Safe-Area Inset Handling (Notch & Dynamic Island)
```css
.r-ui-safe-viewport {
  padding-top: env(safe-area-inset-top, 0px);
  padding-bottom: env(safe-area-inset-bottom, 0px);
  padding-left: env(safe-area-inset-left, 0px);
  padding-right: env(safe-area-inset-right, 0px);
}
```

### B. Touch Target 48px Minimum Expansion
```css
/* Small visual elements (20px icons) still fulfill 48px touch target standard */
.r-ui-touch-target {
  position: relative;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 48px;
  min-height: 48px;
  touch-action: manipulation;
}
```

---

## 4. Foldables & Multi-Screen Displays

### CSS Viewport Segments API (Hinge Safety)
```css
/* Dual-screen horizontal fold posture handling */
@media (horizontal-viewport-segments: 2) {
  .r-ui-foldable-layout {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: env(viewport-segment-width 0 0); /* Clear the hardware hinge crease area */
  }
}

/* 90-degree tabletop fold posture handling */
@media (vertical-viewport-segments: 2) {
  .r-ui-foldable-app {
    display: flex;
    flex-direction: column;
  }
  .r-ui-foldable-content {
    height: env(viewport-segment-height 0 0);
  }
  .r-ui-foldable-controls {
    height: env(viewport-segment-height 0 1);
    background: var(--r-ui-color-surface-elevated);
  }
}
```

---

## 5. Smart TV & 10-Foot UI (Spatial D-Pad Navigation)

### A. TV Focus Glow & Scale State
```css
/* TV focus indicator legible from 3 meters */
.r-ui-tv-node {
  outline: none;
  transition: transform var(--r-ui-duration-fast) var(--r-ui-ease-spring),
              box-shadow var(--r-ui-duration-fast) ease,
              border-color var(--r-ui-duration-fast) ease;
}

.r-ui-tv-node:focus-visible,
.r-ui-tv-node.is-focused {
  transform: scale(1.08);
  border-color: var(--r-ui-color-accent-primary);
  box-shadow: 0 0 0 4px var(--r-ui-color-focus-ring),
              0 16px 36px rgba(0, 0, 0, 0.7);
  z-index: 50;
}
```

### B. Native Spatial D-Pad Navigation Engine (Vanilla JS)
```javascript
/**
 * r-ui TV Spatial Navigation Helper
 * Menangani navigasi remote D-Pad 4-arah (ArrowUp, ArrowDown, ArrowLeft, ArrowRight)
 */
export function initSpatialNavigation(containerSelector = '.r-ui-tv-grid') {
  window.addEventListener('keydown', (e) => {
    const focusable = Array.from(document.querySelectorAll(
      `${containerSelector} [tabindex="0"], ${containerSelector} button, ${containerSelector} a`
    ));
    const active = document.activeElement;
    const currentIndex = focusable.indexOf(active);

    if (currentIndex === -1) {
      if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.key)) {
        focusable[0]?.focus();
        e.preventDefault();
      }
      return;
    }

    const currentRect = active.getBoundingClientRect();
    let bestCandidate = null;
    let minDistance = Infinity;

    for (const node of focusable) {
      if (node === active) continue;
      const rect = node.getBoundingClientRect();

      let isDirectionMatch = false;
      if (e.key === 'ArrowRight') isDirectionMatch = rect.left >= currentRect.right;
      else if (e.key === 'ArrowLeft') isDirectionMatch = rect.right <= currentRect.left;
      else if (e.key === 'ArrowDown') isDirectionMatch = rect.top >= currentRect.bottom;
      else if (e.key === 'ArrowUp') isDirectionMatch = rect.bottom <= currentRect.top;

      if (isDirectionMatch) {
        // Hitung jarak Euclidean antar titik tengah
        const dx = (rect.left + rect.width / 2) - (currentRect.left + currentRect.width / 2);
        const dy = (rect.top + rect.height / 2) - (currentRect.top + currentRect.height / 2);
        const distance = Math.hypot(dx, dy);

        if (distance < minDistance) {
          minDistance = distance;
          bestCandidate = node;
        }
      }
    }

    if (bestCandidate) {
      bestCandidate.focus();
      e.preventDefault();
    }
  });
}
```

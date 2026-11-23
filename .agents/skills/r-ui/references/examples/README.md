# r-ui Interactive Showcase & Playground (v3.0.0)

Self-contained zero-dependency interactive playground for evaluating the visual design, kinetic physics, and accessibility engineering capabilities of `r-ui`.

---

## Getting Started

Requires zero Node.js setup, dev server, or build step. Open the file directly in any modern browser:

```text
references/examples/r-ui-showcase.html
```

---

## Interactive Visual-First Features

1. **Dual-Layer Theme Switcher**:
   - Choose canvas themes (Dark Nebula, Clean Light, Slate Obsidian, Warm Sepia, High Contrast) via the canvas selector.
   - Choose accent color palettes (8 calibrated tones) via circular swatches.
   - Smooth, flicker-free CSS variable transitions (*anti-flicker*).
2. **Adaptive Modal vs Mobile Bottom-Sheet**:
   - Click the **"Open Adaptive Modal"** button.
   - On desktop: modal is centered with crisp micro-elevation.
   - On mobile viewports (< 768px): dialog automatically converts to a native-feel bottom-sheet with safe-area insets.
3. **Law 9: Accessible Custom Popover Select**:
   - Zero raw native `<select>` popups; custom popover with full keyboard navigation and ARIA combobox pattern.
4. **Kinetic Spring Physics & Tactile Micro-Interactions**:
   - Interactive spring toggle switches with haptic thumb slide.
   - `scale(0.975)` tactile click depression on action buttons with snappy spring curves.
   - Dynamic copy button with animated confirmation feedback.
5. **WCAG 2.2 AAA Double-Ring Focus System**:
   - Inner 2px canvas offset with outer 2px primary accent ring on keyboard `Tab` navigation.
6. **Component State Exhaustiveness (The 6 Universal Visual States)**:
   - Live visual comparison grid demonstrating Idle, Hover, Active (Press), Double-Ring Focus, Disabled, and Skeleton Loading shimmer.
7. **Smart TV Spatial Navigation (10-Foot UI)**:
   - Focus any tile within the **Smart TV Spatial Navigation** section.
   - Use keyboard navigation (**Arrow Right, Left, Up, Down**).
   - Crisp 1.08x focus magnification with high-contrast outlines and zero blur glow.
8. **Input Modality Detection**:
   - Automatically detects active pointer modality (Precision Mouse/Trackpad vs Coarse Touchscreen).
9. **Toggle Unstyled Mode**:
   - Click the **"Toggle Unstyled Mode"** button to witness headless component flexibility without styling lock-in.

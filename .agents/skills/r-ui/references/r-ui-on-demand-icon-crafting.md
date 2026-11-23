# r-ui: On-Demand Bespoke SVG Icon Crafting Specification & Protocol

This document defines the official **On-Demand Bespoke SVG Icon Crafting Protocol** for the `r-ui` Universal UI/UX Design System.

Rather than installing bulky, generic third-party icon libraries (Lucide, FontAwesome, Heroicons) that introduce bundle bloat and lack domain-specific symbols, agents and engineers using `r-ui` are empowered to **craft bespoke, production-ready SVG icons on-demand (just-in-time)** as required by the interface or component being constructed.

---

## 1. THE 6 IRON LAWS OF R-UI BESPOKE ICONOGRAPHY

```text
+---------------------------------------------------------------------------------+
|                    THE 6 IRON LAWS OF R-UI ICONOGRAPHY                          |
+---------------------------------------------------------------------------------+
| 1. THE 24×24 OPTICAL GRID  ──► 2px exterior margin; 20×20px live drawing bounds |
| 2. UNIFORM 1.5PX STROKE    ──► Stroke-width: 1.5; round caps & joins; crisp fit |
| 3. 100% CURRENTCOLOR       ──► Zero hardcoded hex/rgb; instant theme reactivity |
| 4. ZERO NEON / BLUR SLOP   ──► Ban filter: drop-shadow and radioactive glows    |
| 5. INTEGER PIXEL SNAPPING  ──► Snap coordinates to integer/half-pixels (no fuzz)|
| 6. MULTI-CHANNEL ACCESSIBLE──► Never color alone; pair with aria-hidden / title |
+---------------------------------------------------------------------------------+
```

1. **Law 1: The 24×24 Optical Grid ($20 \times 20$ Live Zone)**:
   All primary UI icons must be designed on a `viewBox="0 0 24 24"` canvas. Maintain a **2px outer boundary margin** ($x \in [2, 22], y \in [2, 22]$). For compact micro-badges or tabular grids, use a `viewBox="0 0 16 16"` canvas with a **1px outer margin** ($x \in [1, 15], y \in [1, 15]$).
2. **Law 2: Uniform 1.5px Stroke & Curvature**:
   - Stroke width must be **`1.5`** on 24×24 icons. (On micro 16×16 icons, use **`1.75`** or **`2`**).
   - Terminals and corners must declare `stroke-linecap="round"` and `stroke-linejoin="round"`.
   - Never mix stroke weights (e.g. combining 1px with 3px strokes) within the same icon unless creating intentional duotone optical accents.
3. **Law 3: 100% `currentColor` Theme Reactivity**:
   All strokes and accent fills must consume `currentColor`. This guarantees instant, zero-recalculation reactivity to all 5 Canvas Themes (`dark-nebula`, `clean-light`, `slate-obsidian`, `warm-sepia`, `glass-frosted`) and all 8 Calibrated Color Themes (`cyan`, `emerald`, `violet`, `crimson`, `amber`, `monochrome`, `frost`, `coral`).
4. **Law 4: Absolute Ban on Filter/Neon Slop**:
   Never include `<filter>`, `<feGaussianBlur>`, or inline `drop-shadow(...)` filters inside an SVG icon. Elevation and focus are handled cleanly by container classes (`.r-ui-btn`, `.r-ui-card`), not by embedding blur inside vector paths.
5. **Law 5: Integer Pixel Snapping (Anti-Fuzziness)**:
   Avoid floating sub-pixel coordinates like `x="12.3847"` or `y="7.1923"`. Snap straight horizontal and vertical lines to whole numbers (or `.5` when centering a 1px/1.5px stroke on a pixel boundary) to ensure maximum crispness across standard and Retina displays.
6. **Law 6: Multi-Channel Accessibility (WCAG 2.2 AAA)**:
   - If the icon accompanies descriptive text (e.g. `[🔍 Search]`), it is purely decorative: declare `aria-hidden="true"` and `focusable="false"`.
   - If the icon is an interactive button with no text (e.g. an icon-only `[×]` close button), the container button **MUST** declare `aria-label="Close dialog"` or the SVG must contain a descriptive `<title>` element.

---

## 2. THE OPTICAL BALANCE PRINCIPLE

Geometrical shapes have differing visual weights even when their bounding boxes are identical:
- **Square / Rectangular Glyphs** (e.g. CPU chip, terminal console): Have the largest visual area. Inset them slightly from the live bounds (e.g., $18 \times 18\text{px}$ instead of full $20 \times 20\text{px}$) so they do not feel oversized.
- **Circular Glyphs** (e.g. search lens, user avatar ring): Have less visual mass. Draw them to the full $20 \times 20\text{px}$ boundary (radius $r=9$ centered at $(12,12)$).
- **Triangular / Diagonal Glyphs** (e.g. warning alert, chevron): Have the least visual mass. Push apex points to the outer 2px boundary line to achieve equal optical weight against square siblings.

---

## 3. ON-DEMAND GEOMETRIC PRIMITIVES COOKBOOK

When an agent needs an icon on-demand during component implementation, use these mathematically verified path recipes:

### 3.1. Navigation & Wayfinding
```tsx
// Chevron Down (Expand / Dropdown)
<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
  <path d="m6 9 6 6 6-6" />
</svg>

// Chevron Up (Collapse)
<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
  <path d="m18 15-6-6-6 6" />
</svg>

// Arrow Right (Action / Link CTA)
<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
  <path d="M5 12h14M12 5l7 7-7 7" />
</svg>

// Search (Lens + Stem)
<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
  <circle cx="11" cy="11" r="7" />
  <path d="m20 20-3.5-3.5" />
</svg>
```

### 3.2. Actions & System Controls
```tsx
// Close / Dismiss (×)
<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
  <path d="M18 6 6 18M6 6l12 12" />
</svg>

// Checkmark (Success / Complete)
<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
  <path d="M5 13l4 4L19 7" />
</svg>

// Copy to Clipboard
<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
  <rect width="13" height="13" x="8" y="8" rx="2" ry="2" />
  <path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2" />
</svg>

// Sliders / Faceted Filter
<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
  <path d="M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M1 14h6M9 8h6M17 16h6" />
</svg>
```

### 3.3. DevOps, AI & Telemetry Domain
```tsx
// Terminal Console (>_)
<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
  <path d="m4 17 6-6-6-6M12 19h8" />
</svg>

// Pulse / Latency Activity
<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
  <path d="M22 12h-4l-3 9L9 3l-3 9H2" />
</svg>

// CPU / AI Core Chip
<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
  <rect width="12" height="12" x="6" y="6" rx="2" />
  <path d="M9 2v4M15 2v4M9 18v4M15 18v4M2 9h4M2 15h4M18 9h4M18 15h4" />
</svg>

// Git Branch / Multi-Agent Flow
<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
  <circle cx="6" cy="18" r="3" />
  <circle cx="6" cy="6" r="3" />
  <circle cx="18" cy="9" r="3" />
  <path d="M6 9v6M9 6h4a5 5 0 0 1 5 3" />
</svg>

// Database / Storage Bucket
<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
  <ellipse cx="12" cy="5" rx="9" ry="3" />
  <path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5" />
</svg>
```

### 3.4. Semantic Feedback & Security
```tsx
// Warning Triangle
<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
  <path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3ZM12 9v4M12 17h.01" />
</svg>

// Security Shield
<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
  <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
</svg>

// Lock (Security / Secret)
<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
  <rect width="16" height="11" x="4" y="11" rx="2" ry="2" />
  <path d="M7 11V7a5 5 0 0 1 10 0v4" />
</svg>
```

---

## 4. LIGHTWEIGHT INLINE COMPONENT WRAPPER PATTERN

To avoid repetitive SVG boilerplate across components, agents should implement this zero-dependency inline micro-component in the target codebase:

```tsx
import React from 'react';

export interface RUiIconProps extends React.SVGProps<SVGSVGElement> {
  size?: number | 'sm' | 'md' | 'lg';
  label?: string; // Optional accessible title
  children: React.ReactNode;
}

const PRESET_SIZES = {
  sm: 16,
  md: 20,
  lg: 24,
};

export const RUiIcon: React.FC<RUiIconProps> = ({
  size = 'md',
  label,
  className = '',
  style,
  children,
  ...props
}) => {
  const pixelSize = typeof size === 'number' ? size : PRESET_SIZES[size] || 20;

  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      width={pixelSize}
      height={pixelSize}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden={!label}
      role={label ? 'img' : 'presentation'}
      focusable="false"
      className={`r-ui-icon ${className}`}
      style={{
        display: 'inline-block',
        verticalAlign: 'middle',
        flexShrink: 0,
        ...style,
      }}
      {...props}
    >
      {label && <title>{label}</title>}
      {children}
    </svg>
  );
};
```

---

## 5. KINETIC MICRO-INTERACTIONS & MOTION PHYSICS

When crafting bespoke icons, design them to respond to user interaction:
1. **Interactive Trailing Arrow Shift**:
   ```css
   .r-ui-btn:hover .r-ui-icon-trailing {
     transform: translateX(3px);
     transition: transform 180ms cubic-bezier(0.16, 1, 0.3, 1);
   }
   ```
2. **Rotating Chevron on Disclosure**:
   ```css
   .r-ui-disclosure-trigger[aria-expanded="true"] .r-ui-icon-chevron {
     transform: rotate(180deg);
     transition: transform 200ms cubic-bezier(0.16, 1, 0.3, 1);
   }
   ```
3. **State Morphing (Copy to Checkmark)**:
   ```tsx
   export const CopyButton: React.FC<{ text: string }> = ({ text }) => {
     const [copied, setCopied] = React.useState(false);

     const handleCopy = () => {
       navigator.clipboard.writeText(text);
       setCopied(true);
       setTimeout(() => setCopied(false), 1800);
     };

     return (
       <button onClick={handleCopy} className="r-ui-btn r-ui-btn--ghost" aria-label="Copy to clipboard">
         {copied ? (
           <RUiIcon size="sm" style={{ color: 'var(--r-ui-color-success)' }}>
             <path d="M5 13l4 4L19 7" />
           </RUiIcon>
         ) : (
           <RUiIcon size="sm">
             <rect width="13" height="13" x="8" y="8" rx="2" ry="2" />
             <path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2" />
           </RUiIcon>
         )}
       </button>
     );
   };
   ```

---

## 6. ON-DEMAND CRAFTING DECISION TREE FOR AGENTS

When an agent is building or refactoring UI components:

```text
Do I need an icon for this component?
  ├── NO  ──► Proceed with clean typography & spacing (Anti-Slop: don't add icons for decoration).
  └── YES ──► Does an existing component icon already exist?
                ├── YES ──► Reuse the established project icon component.
                └── NO  ──► Craft an On-Demand Bespoke SVG Icon:
                              1. Use viewBox="0 0 24 24", 2px outer margin.
                              2. Set stroke="currentColor", stroke-width="1.5", fill="none".
                              3. Ensure stroke-linecap="round", stroke-linejoin="round".
                              4. Verify WCAG AAA accessibility (aria-hidden or aria-label).
                              5. Test against active themes (dark-nebula, clean-light, accents).
```

---

## 7. DESIGNSPELLS KINETIC MICRO-INTERACTIONS & SVG STATE MORPHING KIT

Following the delight principles of **[designspells.com](https://designspells.com)**, static SVG icons should transform with physical tactile feedback and spring physics during state transitions.

```text
+---------------------------------------------------------------------------------------------------+
|                      DESIGNSPELLS SVG KINETIC STATE MORPHING ARCHITECTURE                         |
+---------------------------------------------------------------------------------------------------+
| 1. SPRING PHYSICS CURVE ──► cubic-bezier(0.16, 1, 0.3, 1) or cubic-bezier(0.34, 1.56, 0.64, 1)    |
| 2. POP & DRAW REVEAL   ──► stroke-dashoffset self-drawing checkmark paired with scale pop (1.15)  |
| 3. CENTER-AXIS ROTATION ──► transform-origin: 12px 12px; zero horizontal layout shifting          |
| 4. RADAR PULSE PING    ──► Multi-ring expanding ripple for live status and telemetry              |
| 5. ZERO JS RUNTIME     ──► 100% hardware-accelerated CSS transforms and path transitions          |
+---------------------------------------------------------------------------------------------------+
```

### 7.1. Zero-Dependency CSS Spring Utilities
Add these lightweight CSS utilities to the project's styling system:

```css
/* r-ui Kinetic Spring Variables */
:root {
  --r-ui-spring-snappy: cubic-bezier(0.16, 1, 0.3, 1);
  --r-ui-spring-bounce: cubic-bezier(0.34, 1.56, 0.64, 1);
  --r-ui-duration-micro: 180ms;
  --r-ui-duration-morph: 240ms;
}

/* Generic Spring Icon Wrapper */
.r-ui-icon-kinetic {
  display: inline-block;
  transform-origin: 12px 12px;
  transition: transform var(--r-ui-duration-micro) var(--r-ui-spring-snappy),
              color var(--r-ui-duration-micro) ease;
}

/* 1. Self-Drawing Stroke Animation */
@keyframes rUiStrokeDraw {
  from {
    stroke-dashoffset: 32;
    opacity: 0;
  }
  to {
    stroke-dashoffset: 0;
    opacity: 1;
  }
}

/* 2. Pop Spring Keyframe */
@keyframes rUiPopSpring {
  0% { transform: scale(0.8); }
  60% { transform: scale(1.15); }
  100% { transform: scale(1); }
}

/* 3. Radar Pulse Keyframe */
@keyframes rUiRadarPulse {
  0% {
    r: 4;
    opacity: 0.8;
  }
  100% {
    r: 10;
    opacity: 0;
  }
}
```

---

### 7.2. Recipe 1: Tactile Copy-to-Checkmark Self-Drawing Morph

When users copy an API token, contract address, or commit hash, the copy icon physically pops and draws a checkmark:

```tsx
import React, { useState } from 'react';

export const KineticCopyButton: React.FC<{ text: string }> = ({ text }) => {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    await navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <button
      onClick={handleCopy}
      className="r-ui-btn r-ui-btn--ghost"
      aria-label={copied ? "Copied to clipboard" : "Copy to clipboard"}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: '6px',
        padding: '6px 10px',
        borderRadius: 'var(--r-ui-radius-sm, 6px)',
        border: '1px solid var(--r-ui-color-border-standard, rgba(255,255,255,0.1))',
        background: 'transparent',
        cursor: 'pointer',
      }}
    >
      <svg
        viewBox="0 0 24 24"
        width="16"
        height="16"
        fill="none"
        stroke={copied ? 'var(--r-ui-color-success, #10b981)' : 'currentColor'}
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
        style={{
          transformOrigin: '12px 12px',
          animation: copied ? 'rUiPopSpring 240ms var(--r-ui-spring-bounce)' : 'none',
          transition: 'stroke 180ms ease',
        }}
      >
        {copied ? (
          <path
            d="M5 13l4 4L19 7"
            style={{
              strokeDasharray: 32,
              animation: 'rUiStrokeDraw 240ms var(--r-ui-spring-snappy) forwards',
            }}
          />
        ) : (
          <g>
            <rect width="13" height="13" x="8" y="8" rx="2" ry="2" />
            <path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2" />
          </g>
        )}
      </svg>
      <span style={{ fontSize: '13px', fontWeight: 500 }}>
        {copied ? 'Copied!' : 'Copy'}
      </span>
    </button>
  );
};
```

---

### 7.3. Recipe 2: Disclosure / Accordion Chevron 180° Smooth Flip

When expanding/collapsing dropdowns or menus, animate the chevron with a snappy spring curve around the central axis:

```tsx
export const ChevronTrigger: React.FC<{ isOpen: boolean; onToggle: () => void; title: string }> = ({
  isOpen,
  onToggle,
  title,
}) => (
  <button
    onClick={onToggle}
    aria-expanded={isOpen}
    className="r-ui-disclosure-trigger"
    style={{
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-between',
      width: '100%',
      padding: '10px 14px',
      background: 'var(--r-ui-color-surface, #141418)',
      border: '1px solid var(--r-ui-color-border-standard, #27272a)',
      borderRadius: 'var(--r-ui-radius-md, 8px)',
      color: 'var(--r-ui-color-text-primary, #f4f4f5)',
      cursor: 'pointer',
    }}
  >
    <span style={{ fontSize: '14px', fontWeight: 500 }}>{title}</span>
    <svg
      viewBox="0 0 24 24"
      width="18"
      height="18"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      style={{
        transformOrigin: '12px 12px',
        transform: isOpen ? 'rotate(180deg)' : 'rotate(0deg)',
        transition: 'transform 220ms cubic-bezier(0.16, 1, 0.3, 1)',
      }}
    >
      <path d="m6 9 6 6 6-6" />
    </svg>
  </button>
);
```

---

### 7.4. Recipe 3: Secret / Password Masking (Eye to Eye-Slash Morph)

Animated toggle between visible password and masked secret. The slash line draws itself diagonally across the pupil:

```tsx
export const EyeToggleIcon: React.FC<{ isVisible: boolean }> = ({ isVisible }) => (
  <svg
    viewBox="0 0 24 24"
    width="18"
    height="18"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.5"
    strokeLinecap="round"
    strokeLinejoin="round"
    style={{ transformOrigin: '12px 12px' }}
  >
    {/* Base Eye Outline */}
    <path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z" />
    {/* Pupil */}
    <circle
      cx="12"
      cy="12"
      r="3"
      style={{
        transformOrigin: '12px 12px',
        transform: isVisible ? 'scale(1)' : 'scale(0.85)',
        transition: 'transform 180ms var(--r-ui-spring-snappy)',
      }}
    />
    {/* Animated Slash Line */}
    <line
      x1="3"
      y1="3"
      x2="21"
      y2="21"
      style={{
        strokeDasharray: 28,
        strokeDashoffset: isVisible ? 28 : 0,
        opacity: isVisible ? 0 : 1,
        transition: 'stroke-dashoffset 200ms cubic-bezier(0.16, 1, 0.3, 1), opacity 150ms ease',
      }}
    />
  </svg>
);
```

---

### 7.5. Recipe 4: Live Telemetry Pulse & Radar Ping (IoT / DevOps Node)

For live connection status, active LLM streaming, or node ping:

```tsx
export const LiveStatusPulse: React.FC<{ isLive?: boolean; label?: string }> = ({
  isLive = true,
  label = "System Operational",
}) => (
  <span
    style={{
      display: 'inline-flex',
      alignItems: 'center',
      gap: '8px',
      fontSize: '12px',
      fontWeight: 500,
      color: isLive ? 'var(--r-ui-color-success, #10b981)' : 'var(--r-ui-color-text-tertiary, #71717a)',
    }}
  >
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none">
      {/* Expanding Radar Ring */}
      {isLive && (
        <circle
          cx="12"
          cy="12"
          r="4"
          stroke="var(--r-ui-color-success, #10b981)"
          strokeWidth="1.5"
          style={{
            transformOrigin: '12px 12px',
            animation: 'rUiRadarPulse 1800ms cubic-bezier(0.16, 1, 0.3, 1) infinite',
          }}
        />
      )}
      {/* Solid Center Core */}
      <circle
        cx="12"
        cy="12"
        r="3.5"
        fill={isLive ? 'var(--r-ui-color-success, #10b981)' : 'currentColor'}
      />
    </svg>
    <span>{label}</span>
  </span>
);
```

---

### 7.6. Recipe 5: Search to Clear (Close Cross) Morphing Input

When users enter a query in a search bar, the leading search lens smoothly morphs into an interactive clear button:

```tsx
export const SearchWithClearMorph: React.FC<{
  value: string;
  onChange: (val: string) => void;
  onClear: () => void;
}> = ({ value, onChange, onClear }) => {
  const hasValue = value.length > 0;

  return (
    <div
      style={{
        position: 'relative',
        display: 'inline-flex',
        alignItems: 'center',
        width: '100%',
        maxWidth: '320px',
      }}
    >
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="Filter records..."
        style={{
          width: '100%',
          padding: '8px 36px 8px 12px',
          background: 'var(--r-ui-color-surface, #141418)',
          border: '1px solid var(--r-ui-color-border-standard, #27272a)',
          borderRadius: 'var(--r-ui-radius-sm, 6px)',
          color: 'var(--r-ui-color-text-primary, #f4f4f5)',
          fontSize: '13px',
          outline: 'none',
        }}
      />
      <button
        onClick={hasValue ? onClear : undefined}
        tabIndex={hasValue ? 0 : -1}
        aria-label={hasValue ? "Clear filter" : "Search"}
        style={{
          position: 'absolute',
          right: '8px',
          background: 'transparent',
          border: 'none',
          padding: '4px',
          cursor: hasValue ? 'pointer' : 'default',
          color: hasValue ? 'var(--r-ui-color-text-primary)' : 'var(--r-ui-color-text-tertiary)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <svg
          viewBox="0 0 24 24"
          width="16"
          height="16"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
          style={{
            transformOrigin: '12px 12px',
            transform: hasValue ? 'rotate(90deg) scale(1)' : 'rotate(0deg) scale(1)',
            transition: 'transform 200ms cubic-bezier(0.16, 1, 0.3, 1), color 150ms ease',
          }}
        >
          {hasValue ? (
            /* Clear '×' */
            <path d="M18 6 6 18M6 6l12 12" />
          ) : (
            /* Search Lens */
            <g>
              <circle cx="11" cy="11" r="7" />
              <path d="m20 20-3.5-3.5" />
            </g>
          )}
        </svg>
      </button>
    </div>
  );
};
```

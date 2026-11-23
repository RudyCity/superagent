# r-ui: Multi-Framework Integration Adapters

Implementation guide and architectural patterns for native -ui components across modern frameworks: **React & Next.js**, **Tailwind CSS (v3 & v4)**, **Vue 3**, **Svelte 5**, and **Ink (Terminal UI)**.

---

## 1. React & Next.js Integration

### A. Strict Variant Props Contract (TypeScript)
Use standardized variant patterns so all atomic components expose consistent prop interfaces:

```typescript
// types/r-ui-props.ts
export type RUiVariant = 'primary' | 'secondary' | 'ghost' | 'destructive';
export type RUiSize = 'sm' | 'md' | 'lg';
export type RUiIntent = 'default' | 'info' | 'success' | 'warning' | 'error';
export type RUiState = 'idle' | 'loading' | 'disabled';

export interface RUiBaseProps {
  className?: string;
  children?: React.ReactNode;
}
```

### B. Compound Component Pattern (Example: Card)
The compound component pattern eliminates prop drilling and enables flexible yet visually consistent layout composition:

```tsx
// components/r-ui/Card.tsx
import React, { createContext, useContext } from 'react';

const CardContext = createContext<{ variant?: string }>({});

export function Card({
  variant = 'default',
  className = '',
  children,
  ...props
}: React.HTMLAttributes<HTMLDivElement> & { variant?: 'default' | 'elevated' | 'interactive' }) {
  return (
    <CardContext.Provider value={{ variant }}>
      <div className={`r-ui-card r-ui-card--${variant} ${className}`} {...props}>
        {children}
      </div>
    </CardContext.Provider>
  );
}

Card.Header = function CardHeader({ className = '', children, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={`r-ui-card-header ${className}`} {...props}>{children}</div>;
};

Card.Title = function CardTitle({ className = '', children, ...props }: React.HTMLAttributes<HTMLHeadingElement>) {
  return <h3 className={`r-ui-card-title ${className}`} {...props}>{children}</h3>;
};

Card.Body = function CardBody({ className = '', children, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={`r-ui-card-body ${className}`} {...props}>{children}</div>;
};

Card.Footer = function CardFooter({ className = '', children, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={`r-ui-card-footer ${className}`} {...props}>{children}</div>;
};
```

---

## 2. Tailwind CSS Integration

### A. Tailwind CSS v4 Configuration (`@theme`)
Di Tailwind CSS v4, petakan langsung token `--r-ui-*` ke variabel tema:

```css
/* app/globals.css */
@import "tailwindcss";
@import "./r-ui-tokens.css";
@import "./r-ui-themes.css";

@theme {
  --color-r-ui-canvas: var(--r-ui-color-canvas);
  --color-r-ui-surface: var(--r-ui-color-surface);
  --color-r-ui-surface-elevated: var(--r-ui-color-surface-elevated);
  --color-r-ui-border-subtle: var(--r-ui-color-border-subtle);
  --color-r-ui-border-strong: var(--r-ui-color-border-strong);
  --color-r-ui-text-primary: var(--r-ui-color-text-primary);
  --color-r-ui-text-secondary: var(--r-ui-color-text-secondary);
  --color-r-ui-accent: var(--r-ui-color-accent-primary);
  --color-r-ui-accent-hover: var(--r-ui-color-accent-primary-hover);

  --spacing-r-ui-1: var(--r-ui-space-1);
  --spacing-r-ui-2: var(--r-ui-space-2);
  --spacing-r-ui-4: var(--r-ui-space-4);
  --spacing-r-ui-6: var(--r-ui-space-6);
  --spacing-r-ui-8: var(--r-ui-space-8);
}
```

### B. Tailwind CSS v3 Configuration (`tailwind.config.js`)
```javascript
// tailwind.config.js
module.exports = {
  theme: {
    extend: {
      colors: {
        'r-ui': {
          canvas: 'var(--r-ui-color-canvas)',
          surface: 'var(--r-ui-color-surface)',
          'surface-elevated': 'var(--r-ui-color-surface-elevated)',
          border: 'var(--r-ui-color-border-standard)',
          'border-subtle': 'var(--r-ui-color-border-subtle)',
          text: 'var(--r-ui-color-text-primary)',
          'text-muted': 'var(--r-ui-color-text-muted)',
          accent: 'var(--r-ui-color-accent-primary)',
        }
      },
      borderRadius: {
        'r-ui-sm': 'var(--r-ui-radius-sm)',
        'r-ui-md': 'var(--r-ui-radius-md)',
        'r-ui-lg': 'var(--r-ui-radius-lg)',
      }
    }
  }
};
```

---

## 3. Vue 3 & Svelte 5 Adapters

### A. Vue 3 (Single File Component with Typed Props)
```vue
<!-- components/RUiButton.vue -->
<script setup lang="ts">
import type { RUiVariant, RUiSize } from '../types/r-ui-props';

withDefaults(defineProps<{
  variant?: RUiVariant;
  size?: RUiSize;
  disabled?: boolean;
}>(), {
  variant: 'primary',
  size: 'md',
  disabled: false
});
</script>

<template>
  <button
    :class="['r-ui-btn', `r-ui-btn-${variant}`, `r-ui-btn-${size}`]"
    :disabled="disabled"
    v-bind="$attrs"
  >
    <slot name="prefix" />
    <slot />
    <slot name="suffix" />
  </button>
</template>
```

### B. Svelte 5 (Runes & Snippets)
```svelte
<!-- components/RUiButton.svelte -->
<script lang="ts">
  import type { RUiVariant, RUiSize } from '../types/r-ui-props';

  let {
    variant = 'primary',
    size = 'md',
    disabled = false,
    children,
    ...rest
  }: {
    variant?: RUiVariant;
    size?: RUiSize;
    disabled?: boolean;
    children?: import('svelte').Snippet;
  } = $props();
</script>

<button
  class="r-ui-btn r-ui-btn-{variant} r-ui-btn-{size}"
  {disabled}
  {...rest}
>
  {@render children?.()}
</button>
```

---

## 4. Ink Terminal UI Adapter (Modern Precision CLI)

For Node.js/Bun CLI applications using Ink, map --r-ui-* tokens to terminal chalk/ink styling:

```tsx
// cli/components/RUiTerminalCard.tsx
import React from 'react';
import { Box, Text } from 'ink';

// r-ui terminal color palette (zero-neon)
export const R_UI_TERMINAL_THEME = {
  canvas: '#090a0f',
  accent: '#38bdf8',
  accentSecondary: '#818cf8',
  border: '#334155',
  textPrimary: '#f8fafc',
  textSecondary: '#94a3b8',
  error: '#ef4444',
  success: '#10b981',
};

export function RUiTerminalCard({
  title,
  children,
  intent = 'default'
}: {
  title: string;
  children: React.ReactNode;
  intent?: 'default' | 'accent' | 'error';
}) {
  const borderColor = intent === 'accent' 
    ? R_UI_TERMINAL_THEME.accent 
    : intent === 'error' 
      ? R_UI_TERMINAL_THEME.error 
      : R_UI_TERMINAL_THEME.border;

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={borderColor} paddingX={1} marginY={1}>
      <Box marginBottom={1}>
        <Text bold color={borderColor}>
          {title.toUpperCase()}
        </Text>
      </Box>
      <Box flexDirection="column">
        {children}
      </Box>
    </Box>
  );
}
```

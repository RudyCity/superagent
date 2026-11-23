/**
 * r-ui Contract Types & Variant Engine (v1.8.0)
 * Namespace: r-ui-*
 * Principles: Zero-Dependency, Type-Safe, Multi-Theme, Anti-Slop
 */

export type RUiVariant = 'primary' | 'secondary' | 'ghost' | 'destructive' | 'outline';
export type RUiSize = 'sm' | 'md' | 'lg';
export type RUiIntent = 'default' | 'info' | 'success' | 'warning' | 'error';
export type RUiState = 'idle' | 'loading' | 'disabled';

export type RUiCanvasTheme =
  | 'dark-nebula'
  | 'clean-light'
  | 'slate-obsidian'
  | 'warm-sepia'
  | 'high-contrast';

export type RUiColorAccent =
  | 'cyan'
  | 'emerald'
  | 'violet'
  | 'crimson'
  | 'amber'
  | 'monochrome'
  | 'frost'
  | 'coral';

export interface RUiComponentContract {
  variant?: RUiVariant;
  size?: RUiSize;
  intent?: RUiIntent;
  state?: RUiState;
  className?: string;
  children?: React.ReactNode;
}

/**
 * Zero-Dependency helper to generate structured r-ui class names.
 * Prevents magic strings and styling inconsistencies.
 */
export function buildRUiClasses(
  baseClass: string,
  modifiers: {
    variant?: RUiVariant;
    size?: RUiSize;
    intent?: RUiIntent;
    state?: RUiState;
    custom?: string;
  }
): string {
  const classes: string[] = [baseClass];

  if (modifiers.variant) classes.push(`${baseClass}--${modifiers.variant}`);
  if (modifiers.size) classes.push(`${baseClass}--${modifiers.size}`);
  if (modifiers.intent && modifiers.intent !== 'default') classes.push(`${baseClass}--intent-${modifiers.intent}`);
  if (modifiers.state && modifiers.state !== 'idle') classes.push(`is-${modifiers.state}`);
  if (modifiers.custom) classes.push(modifiers.custom.trim());

  return classes.filter(Boolean).join(' ');
}

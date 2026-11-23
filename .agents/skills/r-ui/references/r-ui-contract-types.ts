/**
 * r-ui Contract Types & Variant Engine (v3.5.0)
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
 * Toast Notification Contracts (v3.5.0)
 * Actionable toasts with tactile copy button and spring transitions.
 */
export interface RUiToastItem {
  id: string;
  title?: string;
  message: string;
  intent?: RUiIntent;
  duration?: number; // ms before auto-dismiss (default 4000ms), 0 = permanent
  copyable?: boolean; // enable copy-to-clipboard button
  copyText?: string; // custom string to copy (defaults to message)
  onCopy?: (copiedText: string) => void;
  onDismiss?: (id: string) => void;
  action?: {
    label: string;
    onClick: () => void;
  };
}

export interface RUiToastProps extends React.HTMLAttributes<HTMLDivElement> {
  toast: RUiToastItem;
  unstyled?: boolean;
}

export type RUiAlertPosition = 'inline' | 'above-form';

/**
 * In-Page Notification / Alert Contracts (v3.5.0)
 * Contextual alerts positioned inline or anchored directly above forms.
 */
export interface RUiAlertProps extends React.HTMLAttributes<HTMLDivElement> {
  intent?: RUiIntent;
  title?: string;
  position?: RUiAlertPosition;
  copyable?: boolean;
  copyText?: string;
  onCopy?: (copiedText: string) => void;
  onDismiss?: () => void;
  dismissible?: boolean;
  unstyled?: boolean;
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

/**
 * r-ui Compound Components Boilerplate (Project-Adaptive Edition)
 * Supports Headless / Unstyled Mode (unstyled?: boolean) so components can be freely adapted
 * to any project requirements without CSS class conflicts or rigid styling constraints.
 */

import React, { createContext, useContext, useState, useCallback, useEffect } from 'react';
import {
  RUiComponentContract,
  buildRUiClasses,
  RUiToastItem,
  RUiToastProps,
  RUiAlertProps,
  RUiAlertPosition,
  RUiIntent
} from './r-ui-contract-types';

/* ==========================================================================
   1. COMPOUND COMPONENT: CARD (ADAPTIVE & UNSTYLED-CAPABLE)
   ========================================================================== */
interface CardContextValue {
  variant: string;
  unstyled: boolean;
}
const CardContext = createContext<CardContextValue>({ variant: 'default', unstyled: false });

export interface CardProps extends React.HTMLAttributes<HTMLDivElement>, RUiComponentContract {
  /** Disable default styling for 100% customization freedom with Tailwind / custom CSS */
  unstyled?: boolean;
}

export function Card({
  variant = 'primary',
  size = 'md',
  unstyled = false,
  className = '',
  children,
  ...props
}: CardProps) {
  const finalClass = unstyled
    ? className
    : buildRUiClasses('r-ui-card', { variant, size, custom: className });

  return (
    <CardContext.Provider value={{ variant, unstyled }}>
      <div className={finalClass} {...props}>
        {children}
      </div>
    </CardContext.Provider>
  );
}

Card.Header = function CardHeader({ className = '', children, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  const { unstyled } = useContext(CardContext);
  return <div className={unstyled ? className : `r-ui-card__header ${className}`} {...props}>{children}</div>;
};

Card.Title = function CardTitle({ className = '', children, ...props }: React.HTMLAttributes<HTMLHeadingElement>) {
  const { unstyled } = useContext(CardContext);
  return <h3 className={unstyled ? className : `r-ui-card__title ${className}`} {...props}>{children}</h3>;
};

Card.Body = function CardBody({ className = '', children, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  const { unstyled } = useContext(CardContext);
  return <div className={unstyled ? className : `r-ui-card__body ${className}`} {...props}>{children}</div>;
};

Card.Footer = function CardFooter({ className = '', children, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  const { unstyled } = useContext(CardContext);
  return <div className={unstyled ? className : `r-ui-card__footer ${className}`} {...props}>{children}</div>;
};

/* ==========================================================================
   2. COMPOUND COMPONENT: FIELD GROUP (ACCESSIBLE FORM FIELD)
   ========================================================================== */
interface FieldGroupContextValue {
  id: string;
  hasError: boolean;
  unstyled: boolean;
}
const FieldGroupContext = createContext<FieldGroupContextValue>({ id: '', hasError: false, unstyled: false });

export interface FieldGroupProps extends React.HTMLAttributes<HTMLDivElement> {
  id: string;
  intent?: 'default' | 'error';
  unstyled?: boolean;
}

export function FieldGroup({
  id,
  intent = 'default',
  unstyled = false,
  className = '',
  children,
  ...props
}: FieldGroupProps) {
  const hasError = intent === 'error';
  const finalClass = unstyled
    ? className
    : `r-ui-field-group ${hasError ? 'is-error' : ''} ${className}`;

  return (
    <FieldGroupContext.Provider value={{ id, hasError, unstyled }}>
      <div className={finalClass} {...props}>
        {children}
      </div>
    </FieldGroupContext.Provider>
  );
}

FieldGroup.Label = function FieldLabel({ className = '', children, ...props }: React.LabelHTMLAttributes<HTMLLabelElement>) {
  const { id, unstyled } = useContext(FieldGroupContext);
  return (
    <label htmlFor={id} className={unstyled ? className : `r-ui-field-label ${className}`} {...props}>
      {children}
    </label>
  );
};

FieldGroup.Input = function FieldInput({ className = '', ...props }: React.InputHTMLAttributes<HTMLInputElement>) {
  const { id, hasError, unstyled } = useContext(FieldGroupContext);
  return (
    <input
      id={id}
      aria-invalid={hasError ? 'true' : 'false'}
      className={unstyled ? className : `r-ui-input ${className}`}
      {...props}
    />
  );
};

FieldGroup.Hint = function FieldHint({ className = '', children, ...props }: React.HTMLAttributes<HTMLParagraphElement>) {
  const { unstyled } = useContext(FieldGroupContext);
  return <p className={unstyled ? className : `r-ui-field-hint ${className}`} {...props}>{children}</p>;
};

FieldGroup.Error = function FieldError({ className = '', children, ...props }: React.HTMLAttributes<HTMLParagraphElement>) {
  const { hasError, unstyled } = useContext(FieldGroupContext);
  if (!hasError) return null;
  return (
    <p role="alert" className={unstyled ? className : `r-ui-field-error ${className}`} {...props}>
      {children}
    </p>
  );
};

/* ==========================================================================
   3. COMPOUND COMPONENT: ADAPTIVE MODAL / BOTTOM SHEET
   ========================================================================== */
interface ModalContextValue {
  isOpen: boolean;
  onClose: () => void;
  unstyled: boolean;
}
const ModalContext = createContext<ModalContextValue>({ isOpen: false, onClose: () => {}, unstyled: false });

export interface ModalProps {
  isOpen: boolean;
  onClose: () => void;
  unstyled?: boolean;
  className?: string;
  children: React.ReactNode;
}

export function Modal({ isOpen, onClose, unstyled = false, className = '', children }: ModalProps) {
  if (!isOpen) return null;

  return (
    <ModalContext.Provider value={{ isOpen, onClose, unstyled }}>
      <div
        className={unstyled ? 'fixed inset-0 z-50 flex items-center justify-center' : 'r-ui-overlay-backdrop'}
        onClick={onClose}
        role="presentation"
      >
        <div
          className={unstyled ? className : 'r-ui-modal-surface'}
          onClick={(e) => e.stopPropagation()}
          role="dialog"
          aria-modal="true"
        >
          {children}
        </div>
      </div>
    </ModalContext.Provider>
  );
}

Modal.Header = function ModalHeader({ className = '', children, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  const { unstyled } = useContext(ModalContext);
  return <div className={unstyled ? className : `r-ui-modal__header ${className}`} {...props}>{children}</div>;
};

Modal.Title = function ModalTitle({ className = '', children, ...props }: React.HTMLAttributes<HTMLHeadingElement>) {
  const { unstyled } = useContext(ModalContext);
  return <h2 className={unstyled ? className : `r-ui-modal__title ${className}`} {...props}>{children}</h2>;
};

Modal.Body = function ModalBody({ className = '', children, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  const { unstyled } = useContext(ModalContext);
  return <div className={unstyled ? className : `r-ui-modal__body ${className}`} {...props}>{children}</div>;
};

Modal.Footer = function ModalFooter({ className = '', children, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  const { unstyled } = useContext(ModalContext);
  return <div className={unstyled ? className : `r-ui-modal__footer ${className}`} {...props}>{children}</div>;
};

Modal.Close = function ModalClose({ className = '', children = 'Close', ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) {
  const { onClose, unstyled } = useContext(ModalContext);
  return (
    <button
      type="button"
      onClick={onClose}
      className={unstyled ? className : `r-ui-btn r-ui-btn--ghost ${className}`}
      {...props}
    >
      {children}
    </button>
  );
};

/* ==========================================================================
   4. COMPOUND COMPONENT: CUSTOM ACCESSIBLE SELECT (BANS RAW NATIVE <select>)
   ========================================================================== */
interface SelectContextValue {
  value: string;
  onChange: (val: string) => void;
  isOpen: boolean;
  setIsOpen: (open: boolean) => void;
  unstyled: boolean;
}
const SelectContext = createContext<SelectContextValue>({
  value: '',
  onChange: () => {},
  isOpen: false,
  setIsOpen: () => {},
  unstyled: false
});

export interface SelectProps {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  unstyled?: boolean;
  className?: string;
  children: React.ReactNode;
}

export function Select({
  value,
  onChange,
  unstyled = false,
  className = '',
  children
}: SelectProps) {
  const [isOpen, setIsOpen] = useState(false);

  return (
    <SelectContext.Provider value={{ value, onChange, isOpen, setIsOpen, unstyled }}>
      <div
        className={unstyled ? className : `r-ui-custom-select ${isOpen ? 'is-open' : ''} ${className}`}
        onBlur={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget)) {
            setIsOpen(false);
          }
        }}
      >
        {children}
      </div>
    </SelectContext.Provider>
  );
}

Select.Trigger = function SelectTrigger({
  placeholder = 'Select option...',
  className = '',
  children
}: {
  placeholder?: string;
  className?: string;
  children?: React.ReactNode;
}) {
  const { value, isOpen, setIsOpen, unstyled } = useContext(SelectContext);

  return (
    <button
      type="button"
      role="combobox"
      aria-expanded={isOpen}
      aria-haspopup="listbox"
      className={unstyled ? className : `r-ui-select-trigger ${className}`}
      onClick={() => setIsOpen(!isOpen)}
    >
      <span>{children || value || placeholder}</span>
      <svg
        className={unstyled ? '' : 'r-ui-select-chevron'}
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.5"
      >
        <polyline points="6 9 12 15 18 9" />
      </svg>
    </button>
  );
};

Select.Content = function SelectContent({
  className = '',
  children
}: {
  className?: string;
  children: React.ReactNode;
}) {
  const { isOpen, unstyled } = useContext(SelectContext);
  if (!isOpen) return null;

  return (
    <div
      role="listbox"
      className={unstyled ? className : `r-ui-select-popover ${className}`}
    >
      {children}
    </div>
  );
};

Select.Option = function SelectOption({
  value: optValue,
  className = '',
  children
}: {
  value: string;
  className?: string;
  children: React.ReactNode;
}) {
  const { value, onChange, setIsOpen, unstyled } = useContext(SelectContext);
  const isSelected = value === optValue;

  return (
    <div
      role="option"
      aria-selected={isSelected}
      className={
        unstyled
          ? className
          : `r-ui-select-option ${isSelected ? 'is-selected' : ''} ${className}`
      }
      onClick={() => {
        onChange(optValue);
        setIsOpen(false);
      }}
    >
      <span>{children}</span>
      {isSelected && <span>✓</span>}
    </div>
  );
};

/* ==========================================================================
   5. UTILITY & MICRO-ACTION: TACTILE COPY BUTTON
   ========================================================================== */
export interface CopyButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  text: string;
  onCopy?: (copiedText: string) => void;
  copiedDuration?: number;
  label?: string;
  copiedLabel?: string;
  showLabel?: boolean;
  unstyled?: boolean;
}

export function CopyButton({
  text,
  onCopy,
  copiedDuration = 2000,
  label = 'Copy',
  copiedLabel = 'Copied!',
  showLabel = false,
  unstyled = false,
  className = '',
  ...props
}: CopyButtonProps) {
  const [copied, setCopied] = useState(false);

  const handleCopy = useCallback(async (e: React.MouseEvent<HTMLButtonElement>) => {
    e.stopPropagation();
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(text);
      } else {
        const textarea = document.createElement('textarea');
        textarea.value = text;
        textarea.style.position = 'fixed';
        textarea.style.opacity = '0';
        document.body.appendChild(textarea);
        textarea.select();
        document.execCommand('copy');
        document.body.removeChild(textarea);
      }
      setCopied(true);
      if (onCopy) onCopy(text);
      setTimeout(() => setCopied(false), copiedDuration);
    } catch (err) {
      console.error('Failed to copy text:', err);
    }
  }, [text, onCopy, copiedDuration]);

  return (
    <button
      type="button"
      onClick={handleCopy}
      aria-label={copied ? copiedLabel : `${label}: ${text}`}
      title={copied ? copiedLabel : label}
      className={
        unstyled
          ? className
          : `r-ui-copy-btn ${copied ? 'is-copied' : ''} ${className}`
      }
      {...props}
    >
      {copied ? (
        <svg className="r-ui-icon-check" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" width="14" height="14">
          <polyline points="20 6 9 17 4 12" />
        </svg>
      ) : (
        <svg className="r-ui-icon-copy" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" width="14" height="14">
          <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
          <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
        </svg>
      )}
      {showLabel && <span className="r-ui-copy-btn__label">{copied ? copiedLabel : label}</span>}
    </button>
  );
}

/* ==========================================================================
   6. COMPOUND COMPONENT: TOAST NOTIFICATIONS WITH ACTIONABLE COPY
   ========================================================================== */
interface ToastContextValue {
  toasts: RUiToastItem[];
  addToast: (toast: Omit<RUiToastItem, 'id'> & { id?: string }) => string;
  removeToast: (id: string) => void;
  clearToasts: () => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

export function useToast() {
  const context = useContext(ToastContext);
  if (!context) {
    throw new Error('useToast must be used within a ToastProvider');
  }
  return context;
}

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<RUiToastItem[]>([]);

  const removeToast = useCallback((id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const clearToasts = useCallback(() => {
    setToasts([]);
  }, []);

  const addToast = useCallback(
    (toast: Omit<RUiToastItem, 'id'> & { id?: string }) => {
      const id = toast.id || `toast-${Date.now()}-${Math.random().toString(36).substr(2, 6)}`;
      const newToast: RUiToastItem = {
        id,
        duration: 4000,
        copyable: true,
        ...toast
      };

      setToasts((prev) => [...prev, newToast]);

      if (newToast.duration && newToast.duration > 0) {
        setTimeout(() => {
          removeToast(id);
        }, newToast.duration);
      }

      return id;
    },
    [removeToast]
  );

  return (
    <ToastContext.Provider value={{ toasts, addToast, removeToast, clearToasts }}>
      {children}
      <ToastStack toasts={toasts} onDismiss={removeToast} />
    </ToastContext.Provider>
  );
}

export function ToastStack({
  toasts,
  onDismiss,
  unstyled = false,
  className = ''
}: {
  toasts: RUiToastItem[];
  onDismiss: (id: string) => void;
  unstyled?: boolean;
  className?: string;
}) {
  if (toasts.length === 0) return null;

  return (
    <aside
      aria-label="Notification toasts"
      aria-live="polite"
      className={unstyled ? className : `r-ui-toast-container ${className}`}
    >
      {toasts.map((toast) => (
        <ToastItem key={toast.id} toast={toast} onDismiss={() => onDismiss(toast.id)} unstyled={unstyled} />
      ))}
    </aside>
  );
}

export function ToastItem({
  toast,
  onDismiss,
  unstyled = false,
  className = ''
}: {
  toast: RUiToastItem;
  onDismiss: () => void;
  unstyled?: boolean;
  className?: string;
}) {
  const intent = toast.intent || 'default';
  const copyTarget = toast.copyText || toast.message;

  return (
    <div
      role={intent === 'error' ? 'alert' : 'status'}
      className={
        unstyled
          ? className
          : `r-ui-toast r-ui-toast--${intent} ${className}`
      }
    >
      {/* Intent Status Icon */}
      <div className="r-ui-toast__icon" aria-hidden="true">
        {intent === 'success' && (
          <svg viewBox="0 0 24 24" width="16" height="16" stroke="currentColor" fill="none" strokeWidth="2.5">
            <polyline points="20 6 9 17 4 12" />
          </svg>
        )}
        {intent === 'error' && (
          <svg viewBox="0 0 24 24" width="16" height="16" stroke="currentColor" fill="none" strokeWidth="2.5">
            <circle cx="12" cy="12" r="10" /><line x1="12" y1="8" x2="12" y2="12" /><line x1="12" y1="16" x2="12.01" y2="16" />
          </svg>
        )}
        {intent === 'warning' && (
          <svg viewBox="0 0 24 24" width="16" height="16" stroke="currentColor" fill="none" strokeWidth="2.5">
            <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" /><line x1="12" y1="9" x2="12" y2="13" /><line x1="12" y1="17" x2="12.01" y2="17" />
          </svg>
        )}
        {(intent === 'info' || intent === 'default') && (
          <svg viewBox="0 0 24 24" width="16" height="16" stroke="currentColor" fill="none" strokeWidth="2.5">
            <circle cx="12" cy="12" r="10" /><line x1="12" y1="16" x2="12" y2="12" /><line x1="12" y1="8" x2="12.01" y2="8" />
          </svg>
        )}
      </div>

      {/* Content */}
      <div className="r-ui-toast__content">
        {toast.title && <div className="r-ui-toast__title">{toast.title}</div>}
        <div className="r-ui-toast__message">{toast.message}</div>
      </div>

      {/* Action Area */}
      <div className="r-ui-toast__actions">
        {toast.copyable !== false && (
          <CopyButton
            text={copyTarget}
            onCopy={toast.onCopy}
            className="r-ui-toast__copy-btn"
            title="Copy notification text"
          />
        )}
        {toast.action && (
          <button
            type="button"
            onClick={toast.action.onClick}
            className="r-ui-toast__action-btn"
          >
            {toast.action.label}
          </button>
        )}
        <button
          type="button"
          onClick={onDismiss}
          className="r-ui-toast__close-btn"
          aria-label="Dismiss notification"
        >
          <svg viewBox="0 0 24 24" width="14" height="14" stroke="currentColor" fill="none" strokeWidth="2.5">
            <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </button>
      </div>
    </div>
  );
}

/* ==========================================================================
   7. COMPOUND COMPONENT: IN-PAGE NOTIFICATION / ALERT (ABOVE-FORM COMPLIANT)
   ========================================================================== */
interface AlertContextValue {
  intent: RUiIntent;
  unstyled: boolean;
  position: RUiAlertPosition;
}

const AlertContext = createContext<AlertContextValue>({
  intent: 'default',
  unstyled: false,
  position: 'inline'
});

export function Alert({
  intent = 'default',
  position = 'inline',
  copyable = false,
  copyText = '',
  onCopy,
  dismissible = false,
  onDismiss,
  unstyled = false,
  className = '',
  children,
  ...props
}: RUiAlertProps) {
  const [dismissed, setDismissed] = useState(false);

  if (dismissed) return null;

  const handleDismiss = () => {
    setDismissed(true);
    if (onDismiss) onDismiss();
  };

  const isAboveForm = position === 'above-form';
  const finalClass = unstyled
    ? className
    : `r-ui-alert r-ui-alert--${intent} ${isAboveForm ? 'r-ui-alert--above-form' : ''} ${className}`;

  return (
    <AlertContext.Provider value={{ intent, unstyled, position }}>
      <div
        role={intent === 'error' ? 'alert' : 'status'}
        aria-live={intent === 'error' ? 'assertive' : 'polite'}
        className={finalClass}
        {...props}
      >
        <div className="r-ui-alert__inner">
          <div className="r-ui-alert__body">{children}</div>
          <div className="r-ui-alert__actions">
            {copyable && (
              <CopyButton
                text={copyText}
                onCopy={onCopy}
                className="r-ui-alert__copy-btn"
                title="Copy notification payload"
              />
            )}
            {dismissible && (
              <button
                type="button"
                onClick={handleDismiss}
                className="r-ui-alert__close-btn"
                aria-label="Dismiss alert"
              >
                <svg viewBox="0 0 24 24" width="14" height="14" stroke="currentColor" fill="none" strokeWidth="2.5">
                  <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
                </svg>
              </button>
            )}
          </div>
        </div>
      </div>
    </AlertContext.Provider>
  );
}

Alert.Title = function AlertTitle({ className = '', children, ...props }: React.HTMLAttributes<HTMLHeadingElement>) {
  const { unstyled } = useContext(AlertContext);
  return <h4 className={unstyled ? className : `r-ui-alert__title ${className}`} {...props}>{children}</h4>;
};

Alert.Description = function AlertDescription({ className = '', children, ...props }: React.HTMLAttributes<HTMLParagraphElement>) {
  const { unstyled } = useContext(AlertContext);
  return <p className={unstyled ? className : `r-ui-alert__description ${className}`} {...props}>{children}</p>;
};


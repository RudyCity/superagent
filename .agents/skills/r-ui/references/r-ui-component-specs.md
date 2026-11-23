# r-ui: Complete Component Anatomy & Interaction Specifications (v3.0.0)

Comprehensive modular component specifications for production-grade Universal UI/UX Design System.
**Visual-first**, anti-slop, free of murky dark shadows, free of neon/glow effects, and 100% powered by native --r-ui-* tokens.

---

## 1. Action Button System
Interactive buttons with tactile spring physics, accessible state management, and zero-neon discipline.

```css
.r-ui-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: var(--r-ui-space-2);
  padding: 6px var(--r-ui-space-3);
  min-height: 34px;
  font-family: inherit;
  font-size: 0.8125rem;
  font-weight: 600;
  border-radius: var(--r-ui-radius-xs);
  border: 1px solid transparent;
  cursor: pointer;
  user-select: none;
  touch-action: manipulation;
  transition: transform var(--r-ui-duration-fast) var(--r-ui-ease-spring),
              background-color var(--r-ui-duration-fast) ease,
              border-color var(--r-ui-duration-fast) ease;
}
.r-ui-btn:active { transform: scale(0.98); }
.r-ui-btn--primary {
  background-color: var(--r-ui-color-accent-primary);
  color: var(--r-ui-color-text-inverse);
  box-shadow: var(--r-ui-shadow-xs);
}
.r-ui-btn--secondary {
  background-color: var(--r-ui-color-surface-elevated);
  border-color: var(--r-ui-color-border-standard);
  color: var(--r-ui-color-text-primary);
  box-shadow: var(--r-ui-border-inner-glass);
}
.r-ui-btn--ghost { background: transparent; color: var(--r-ui-color-text-secondary); }
.r-ui-btn--destructive { background: var(--r-ui-color-error-bg); border-color: rgba(244, 63, 94, 0.2); color: var(--r-ui-color-error); }
.r-ui-btn--outline { background: transparent; border-color: var(--r-ui-color-border-standard); color: var(--r-ui-color-text-primary); }
```

---

## 2. Accessible Form Inputs (Text, Password, Search)
```css
.r-ui-input-wrapper {
  position: relative;
  display: flex;
  align-items: center;
  width: 100%;
}
.r-ui-input {
  width: 100%;
  min-height: 34px;
  padding: 6px var(--r-ui-space-3);
  background-color: var(--r-ui-color-surface-elevated);
  border: 1px solid var(--r-ui-color-border-standard);
  border-radius: var(--r-ui-radius-xs);
  color: var(--r-ui-color-text-primary);
  font-size: 0.8125rem;
  font-family: inherit;
  outline: none;
  transition: all var(--r-ui-duration-fast) var(--r-ui-ease-spring);
}
.r-ui-input:focus {
  border-color: var(--r-ui-color-accent-primary);
  box-shadow: 0 0 0 1px var(--r-ui-color-focus-ring);
  background-color: var(--r-ui-color-surface);
}
.r-ui-input.is-error {
  border-color: var(--r-ui-color-error);
  box-shadow: 0 0 0 1px var(--r-ui-color-error);
}
```

---

## 3. Custom Accessible Select Component (BANS RAW NATIVE <select>)

Raw native <select> and <option> elements are **strictly banned** because OS popups break dark themes and CSS custom properties. Use -ui Custom Select Component:

```css
.r-ui-custom-select {
  position: relative;
  display: inline-block;
  width: 100%;
}

.r-ui-select-trigger {
  width: 100%;
  min-height: 34px;
  padding: 6px var(--r-ui-space-3);
  background-color: var(--r-ui-color-surface-elevated);
  border: 1px solid var(--r-ui-color-border-standard);
  border-radius: var(--r-ui-radius-xs);
  color: var(--r-ui-color-text-primary);
  font-size: 0.8125rem;
  font-family: inherit;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--r-ui-space-2);
  cursor: pointer;
  user-select: none;
  box-shadow: var(--r-ui-border-inner-glass);
  transition: all var(--r-ui-duration-fast) var(--r-ui-ease-spring);
}

.r-ui-select-trigger:hover {
  border-color: var(--r-ui-color-border-strong);
  background-color: var(--r-ui-color-surface-overlay);
}

.r-ui-select-trigger:focus-visible,
.r-ui-custom-select.is-open .r-ui-select-trigger {
  border-color: var(--r-ui-color-accent-primary);
  box-shadow: 0 0 0 1px var(--r-ui-color-focus-ring);
  outline: none;
}

.r-ui-select-chevron {
  width: 14px;
  height: 14px;
  color: var(--r-ui-color-text-tertiary);
  transition: transform var(--r-ui-duration-fast) var(--r-ui-ease-spring);
  flex-shrink: 0;
}

.r-ui-custom-select.is-open .r-ui-select-chevron {
  transform: rotate(180deg);
  color: var(--r-ui-color-accent-primary);
}

.r-ui-select-popover {
  position: absolute;
  top: calc(100% + 4px);
  left: 0;
  right: 0;
  z-index: var(--r-ui-z-dropdown);
  background-color: var(--r-ui-color-surface);
  border: 1px solid var(--r-ui-color-border-strong);
  border-radius: var(--r-ui-radius-xs);
  box-shadow: var(--r-ui-shadow-lg), var(--r-ui-border-inner-glass);
  max-height: 240px;
  overflow-y: auto;
  display: none;
  flex-direction: column;
  padding: 4px;
  gap: 2px;
  animation: r-ui-popover-in 0.16s var(--r-ui-ease-spring);
}

.r-ui-custom-select.is-open .r-ui-select-popover {
  display: flex;
}

.r-ui-select-option {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 6px 10px;
  border-radius: 2px;
  color: var(--r-ui-color-text-secondary);
  font-size: 0.8125rem;
  cursor: pointer;
  transition: all var(--r-ui-duration-fast) ease;
}

.r-ui-select-option:hover,
.r-ui-select-option.is-focused {
  background-color: var(--r-ui-color-surface-elevated);
  color: var(--r-ui-color-text-primary);
}

.r-ui-select-option.is-selected {
  background-color: var(--r-ui-color-surface-overlay);
  color: var(--r-ui-color-accent-primary);
  font-weight: 600;
}
```

---

## 4. Tactile Spring Toggle / Switch
```css
.r-ui-switch {
  position: relative;
  display: inline-flex;
  align-items: center;
  width: 40px;
  height: 22px;
  background-color: var(--r-ui-color-surface-overlay);
  border-radius: var(--r-ui-radius-full);
  border: 1px solid var(--r-ui-color-border-standard);
  cursor: pointer;
  transition: background-color var(--r-ui-duration-fast) ease;
}
.r-ui-switch.is-active {
  background-color: var(--r-ui-color-accent-primary);
  border-color: var(--r-ui-color-accent-primary);
}
.r-ui-switch__thumb {
  position: absolute;
  left: 2px;
  width: 16px;
  height: 16px;
  border-radius: 50%;
  background-color: #ffffff;
  box-shadow: var(--r-ui-shadow-xs);
  transition: transform var(--r-ui-duration-fast) var(--r-ui-ease-spring);
}
.r-ui-switch.is-active .r-ui-switch__thumb {
  transform: translateX(18px);
  background-color: var(--r-ui-color-text-inverse);
}
```

---

## 5. Custom Checkbox & Radio
```css
.r-ui-checkbox, .r-ui-radio {
  display: inline-flex;
  align-items: center;
  gap: var(--r-ui-space-2);
  cursor: pointer;
  font-size: 0.8125rem;
  user-select: none;
}
.r-ui-checkbox__box {
  width: 16px;
  height: 16px;
  border-radius: var(--r-ui-radius-xs);
  border: 1px solid var(--r-ui-color-border-strong);
  background-color: var(--r-ui-color-surface-elevated);
  display: flex;
  align-items: center;
  justify-content: center;
  transition: all var(--r-ui-duration-fast) ease;
}
.r-ui-checkbox.is-checked .r-ui-checkbox__box {
  background-color: var(--r-ui-color-accent-primary);
  border-color: var(--r-ui-color-accent-primary);
  color: var(--r-ui-color-text-inverse);
}
.r-ui-radio__circle {
  width: 16px;
  height: 16px;
  border-radius: 50%;
  border: 1px solid var(--r-ui-color-border-strong);
  background-color: var(--r-ui-color-surface-elevated);
  display: flex;
  align-items: center;
  justify-content: center;
}
.r-ui-radio.is-checked .r-ui-radio__circle::after {
  content: '';
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background-color: var(--r-ui-color-accent-primary);
}
```

---

## 6. Status Badges & Pulse Indicators
```css
.r-ui-badge {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  font-family: var(--r-ui-font-family-mono);
  font-size: 0.6875rem;
  font-weight: 600;
  padding: 2px 7px;
  border-radius: var(--r-ui-radius-xs);
  border: 1px solid transparent;
}
.r-ui-badge--success { background: var(--r-ui-color-success-bg); color: var(--r-ui-color-success); border-color: rgba(16, 185, 129, 0.2); }
.r-ui-badge--warning { background: var(--r-ui-color-warning-bg); color: var(--r-ui-color-warning); border-color: rgba(245, 158, 11, 0.2); }
.r-ui-badge--error { background: var(--r-ui-color-error-bg); color: var(--r-ui-color-error); border-color: rgba(244, 63, 94, 0.2); }
.r-ui-badge--info { background: var(--r-ui-color-info-bg); color: var(--r-ui-color-info); border-color: rgba(14, 165, 233, 0.2); }
```

---

## 7. Avatars & Avatar Groups
```css
.r-ui-avatar {
  position: relative;
  width: 32px;
  height: 32px;
  border-radius: 50%;
  background-color: var(--r-ui-color-surface-overlay);
  border: 1px solid var(--r-ui-color-border-standard);
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 0.75rem;
  font-weight: 700;
}
.r-ui-avatar-group {
  display: flex;
  align-items: center;
}
.r-ui-avatar-group .r-ui-avatar {
  margin-left: -8px;
  border: 2px solid var(--r-ui-color-surface);
}
.r-ui-avatar-group .r-ui-avatar:first-child { margin-left: 0; }
```

---

## 8. Tabs & Accordions
```css
.r-ui-tabs-nav {
  display: flex;
  align-items: center;
  gap: var(--r-ui-space-2);
  border-bottom: 1px solid var(--r-ui-color-border-standard);
}
.r-ui-tab-btn {
  background: transparent;
  border: none;
  border-bottom: 2px solid transparent;
  color: var(--r-ui-color-text-secondary);
  font-size: 0.8125rem;
  font-weight: 600;
  padding: 8px var(--r-ui-space-3);
  cursor: pointer;
  transition: all var(--r-ui-duration-fast) ease;
}
.r-ui-tab-btn.is-active {
  color: var(--r-ui-color-accent-primary);
  border-bottom-color: var(--r-ui-color-accent-primary);
}
.r-ui-accordion-item {
  border: 1px solid var(--r-ui-color-border-standard);
  border-radius: var(--r-ui-radius-xs);
  overflow: hidden;
  background-color: var(--r-ui-color-surface);
}
.r-ui-accordion-header {
  padding: var(--r-ui-space-3) var(--r-ui-space-4);
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: space-between;
  font-size: 0.8125rem;
  font-weight: 600;
  background-color: var(--r-ui-color-surface-elevated);
}
.r-ui-accordion-content {
  padding: var(--r-ui-space-3) var(--r-ui-space-4);
  font-size: 0.8125rem;
  color: var(--r-ui-color-text-secondary);
  display: none;
}
.r-ui-accordion-item.is-open .r-ui-accordion-content {
  display: block;
}
```

---

## 9. Toast Notifications & Alert Banners
```css
.r-ui-toast-container {
  position: fixed;
  bottom: var(--r-ui-space-5);
  right: var(--r-ui-space-5);
  display: flex;
  flex-direction: column;
  gap: var(--r-ui-space-2);
  z-index: var(--r-ui-z-toast);
}
.r-ui-toast {
  background-color: var(--r-ui-color-surface-elevated);
  border: 1px solid var(--r-ui-color-border-strong);
  border-radius: var(--r-ui-radius-sm);
  padding: var(--r-ui-space-3) var(--r-ui-space-4);
  box-shadow: var(--r-ui-shadow-lg);
  display: flex;
  align-items: center;
  gap: var(--r-ui-space-3);
  font-size: 0.8125rem;
  animation: r-ui-slide-toast 0.2s var(--r-ui-ease-spring);
}
```

---

## 10. High-Density Data Grid & Table Pagination
```css
.r-ui-table-container {
  width: 100%;
  overflow-x: auto;
  border: 1px solid var(--r-ui-color-border-standard);
  border-radius: var(--r-ui-radius-sm);
  background-color: var(--r-ui-color-surface);
}

.r-ui-table {
  width: 100%;
  border-collapse: collapse;
  text-align: left;
  font-size: 0.8125rem;
}

.r-ui-table th {
  padding: 10px 14px;
  background-color: var(--r-ui-color-surface-elevated);
  color: var(--r-ui-color-text-secondary);
  font-weight: 600;
  font-size: 0.75rem;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  border-bottom: 1px solid var(--r-ui-color-border-standard);
  user-select: none;
}

.r-ui-table th.is-sortable {
  cursor: pointer;
  transition: color var(--r-ui-duration-fast) ease;
}

.r-ui-table th.is-sortable:hover {
  color: var(--r-ui-color-text-primary);
}

.r-ui-table td {
  padding: 10px 14px;
  border-bottom: 1px solid var(--r-ui-color-border-subtle);
  color: var(--r-ui-color-text-primary);
  vertical-align: middle;
}

.r-ui-table tr:hover td {
  background-color: var(--r-ui-color-surface-overlay);
}

.r-ui-table tr.is-selected td {
  background-color: rgba(var(--r-ui-color-accent-primary-rgb, 56, 189, 248), 0.08);
}

.r-ui-table td.is-number {
  text-align: right;
  font-family: var(--r-ui-font-family-mono);
  font-variant-numeric: tabular-nums;
}

.r-ui-pagination {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 16px;
  border-top: 1px solid var(--r-ui-color-border-standard);
  font-size: 0.8125rem;
  color: var(--r-ui-color-text-secondary);
  background-color: var(--r-ui-color-surface-elevated);
}
```

---

## 11. Metric KPI Cards & Architectural Telemetry Ribbon
```css
/* Metric Stat Card */
.r-ui-stat-card {
  background-color: var(--r-ui-color-surface);
  border: 1px solid var(--r-ui-color-border-standard);
  border-radius: var(--r-ui-radius-sm);
  padding: 16px;
  display: flex;
  flex-direction: column;
  gap: 8px;
  box-shadow: var(--r-ui-border-inner-glass);
}

.r-ui-stat-card__label {
  font-size: 0.75rem;
  color: var(--r-ui-color-text-secondary);
  font-weight: 500;
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.r-ui-stat-card__value {
  font-size: 1.5rem;
  font-weight: 700;
  color: var(--r-ui-color-text-primary);
  font-family: var(--r-ui-font-family-mono);
  letter-spacing: -0.02em;
}

.r-ui-stat-card__footer {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 0.75rem;
}

/* Telemetry Ribbon (Anti-Card Overuse) */
.r-ui-telemetry-ribbon {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
  background-color: var(--r-ui-color-surface);
  border: 1px solid var(--r-ui-color-border-standard);
  border-radius: var(--r-ui-radius-sm);
  overflow: hidden;
}

.r-ui-telemetry-item {
  padding: 12px 16px;
  border-right: 1px solid var(--r-ui-color-border-standard);
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.r-ui-telemetry-item:last-child {
  border-right: none;
}
```

---

## 12. Modal Dialog & Slide-Over Inspector Drawer
```css
/* Modal Backdrop & Dialog */
.r-ui-modal-backdrop {
  position: fixed;
  inset: 0;
  background-color: rgba(0, 0, 0, 0.65);
  backdrop-filter: blur(6px);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: var(--r-ui-z-modal);
  padding: var(--r-ui-space-4);
  animation: r-ui-fade-in 0.18s ease;
}

.r-ui-modal {
  background-color: var(--r-ui-color-surface);
  border: 1px solid var(--r-ui-color-border-strong);
  border-radius: var(--r-ui-radius-md);
  box-shadow: var(--r-ui-shadow-lg);
  width: 100%;
  max-width: 540px;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  animation: r-ui-modal-in 0.2s var(--r-ui-ease-spring);
}

.r-ui-modal-header {
  padding: 14px 18px;
  border-bottom: 1px solid var(--r-ui-color-border-standard);
  display: flex;
  align-items: center;
  justify-content: space-between;
  font-weight: 600;
  font-size: 0.9375rem;
}

.r-ui-modal-body {
  padding: 18px;
  overflow-y: auto;
  max-height: 70vh;
}

.r-ui-modal-footer {
  padding: 12px 18px;
  border-top: 1px solid var(--r-ui-color-border-standard);
  background-color: var(--r-ui-color-surface-elevated);
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: var(--r-ui-space-2);
}

/* Slide-Over Drawer */
.r-ui-drawer {
  position: fixed;
  top: 0;
  right: 0;
  bottom: 0;
  width: 100%;
  max-width: 460px;
  background-color: var(--r-ui-color-surface);
  border-left: 1px solid var(--r-ui-color-border-strong);
  box-shadow: var(--r-ui-shadow-lg);
  z-index: var(--r-ui-z-modal);
  display: flex;
  flex-direction: column;
  animation: r-ui-slide-in-right 0.22s var(--r-ui-ease-spring);
}
```

---

## 13. Command Palette (`Ctrl + K`)
```css
.r-ui-command-dialog {
  width: 100%;
  max-width: 600px;
  background-color: var(--r-ui-color-surface);
  border: 1px solid var(--r-ui-color-border-strong);
  border-radius: var(--r-ui-radius-md);
  box-shadow: var(--r-ui-shadow-lg);
  overflow: hidden;
}

.r-ui-command-input-wrapper {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 12px 16px;
  border-bottom: 1px solid var(--r-ui-color-border-standard);
}

.r-ui-command-input {
  width: 100%;
  background: transparent;
  border: none;
  color: var(--r-ui-color-text-primary);
  font-size: 0.9375rem;
  outline: none;
}

.r-ui-command-list {
  max-height: 320px;
  overflow-y: auto;
  padding: 6px;
}

.r-ui-command-group-heading {
  font-size: 0.6875rem;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: var(--r-ui-color-text-tertiary);
  padding: 8px 10px 4px;
  font-weight: 600;
}

.r-ui-command-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 12px;
  border-radius: var(--r-ui-radius-xs);
  color: var(--r-ui-color-text-secondary);
  font-size: 0.8125rem;
  cursor: pointer;
}

.r-ui-command-item:hover,
.r-ui-command-item.is-active {
  background-color: var(--r-ui-color-surface-elevated);
  color: var(--r-ui-color-text-primary);
}
```

---

## 14. Floating Bulk Action Bar
```css
.r-ui-bulk-bar {
  position: fixed;
  bottom: 24px;
  left: 50%;
  transform: translateX(-50%);
  z-index: var(--r-ui-z-toast);
  background-color: var(--r-ui-color-surface-elevated);
  border: 1px solid var(--r-ui-color-border-strong);
  border-radius: var(--r-ui-radius-full);
  padding: 8px 18px;
  box-shadow: var(--r-ui-shadow-lg);
  display: flex;
  align-items: center;
  gap: 12px;
  animation: r-ui-slide-up 0.2s var(--r-ui-ease-spring);
}

.r-ui-bulk-bar__count {
  font-size: 0.8125rem;
  font-weight: 600;
  color: var(--r-ui-color-text-primary);
  padding-right: 12px;
  border-right: 1px solid var(--r-ui-color-border-standard);
}
```


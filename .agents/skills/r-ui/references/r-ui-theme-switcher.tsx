/**
 * r-ui Interactive Theme Switcher & Color Accent Picker (v1.8.0)
 * Principles: Zero-Neon, Anti-Flicker Smooth Transition, Minimalist Refinement
 */

import React, { useEffect, useState } from 'react';
import { RUiCanvasTheme, RUiColorAccent } from './r-ui-contract-types';

const CANVAS_THEMES: { id: RUiCanvasTheme; label: string }[] = [
  { id: 'dark-nebula', label: 'Dark Nebula' },
  { id: 'clean-light', label: 'Clean Light' },
  { id: 'slate-obsidian', label: 'Slate Obsidian' },
  { id: 'warm-sepia', label: 'Warm Sepia' },
  { id: 'high-contrast', label: 'High Contrast' },
];

const ACCENT_COLORS: { id: RUiColorAccent; label: string; hex: string }[] = [
  { id: 'cyan', label: 'Precision Cyan', hex: '#38bdf8' },
  { id: 'emerald', label: 'Calibrated Emerald', hex: '#10b981' },
  { id: 'violet', label: 'Royal Violet', hex: '#a855f7' },
  { id: 'crimson', label: 'Ruby Crimson', hex: '#f43f5e' },
  { id: 'amber', label: 'Solar Amber', hex: '#f59e0b' },
  { id: 'monochrome', label: 'Titanium Slate', hex: '#94a3b8' },
  { id: 'frost', label: 'Nordic Teal', hex: '#2dd4bf' },
  { id: 'coral', label: 'Sunset Coral', hex: '#fb7185' },
];

export function RUiThemeSwitcher({ className = '' }: { className?: string }) {
  const [theme, setTheme] = useState<RUiCanvasTheme>('dark-nebula');
  const [accent, setAccent] = useState<RUiColorAccent>('cyan');

  // Load awal dari localStorage atau atribut HTML saat mount
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const storedTheme = (localStorage.getItem('r-ui-theme') as RUiCanvasTheme) ||
      document.documentElement.getAttribute('data-r-ui-theme') ||
      'dark-nebula';
    const storedAccent = (localStorage.getItem('r-ui-accent') as RUiColorAccent) ||
      document.documentElement.getAttribute('data-r-ui-accent') ||
      'cyan';

    setTheme(storedTheme as RUiCanvasTheme);
    setAccent(storedAccent as RUiColorAccent);
    applyTheme(storedTheme as RUiCanvasTheme, storedAccent as RUiColorAccent);
  }, []);

  const applyTheme = (newTheme: RUiCanvasTheme, newAccent: RUiColorAccent) => {
    // Enable smooth transition temporarily during theme switch
    document.documentElement.style.transition = 'background-color 0.2s ease, border-color 0.2s ease, color 0.2s ease';
    document.documentElement.setAttribute('data-r-ui-theme', newTheme);
    document.documentElement.setAttribute('data-r-ui-accent', newAccent);
    localStorage.setItem('r-ui-theme', newTheme);
    localStorage.setItem('r-ui-accent', newAccent);

    // Bersihkan inline transition setelah selesai agar tidak membebani animasi lain
    const timeout = setTimeout(() => {
      document.documentElement.style.transition = '';
    }, 250);
    return () => clearTimeout(timeout);
  };

  const handleThemeChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const newTheme = e.target.value as RUiCanvasTheme;
    setTheme(newTheme);
    applyTheme(newTheme, accent);
  };

  const handleAccentChange = (newAccent: RUiColorAccent) => {
    setAccent(newAccent);
    applyTheme(theme, newAccent);
  };

  return (
    <div
      className={`r-ui-theme-switcher ${className}`}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 'var(--r-ui-space-3)',
        padding: 'var(--r-ui-space-2) var(--r-ui-space-3)',
        backgroundColor: 'var(--r-ui-color-surface-elevated)',
        border: '1px solid var(--r-ui-color-border-standard)',
        borderRadius: 'var(--r-ui-radius-md)',
      }}
    >
      {/* Canvas Theme Dropdown */}
      <select
        value={theme}
        onChange={handleThemeChange}
        aria-label="Select Canvas Theme"
        style={{
          background: 'transparent',
          color: 'var(--r-ui-color-text-primary)',
          border: '1px solid var(--r-ui-color-border-subtle)',
          borderRadius: 'var(--r-ui-radius-sm)',
          padding: '4px 8px',
          fontSize: 'var(--r-ui-font-small)',
          cursor: 'pointer',
          outline: 'none',
        }}
      >
        {CANVAS_THEMES.map((t) => (
          <option key={t.id} value={t.id} style={{ background: '#12141c', color: '#f8fafc' }}>
            {t.label}
          </option>
        ))}
      </select>

      {/* Accent Color Swatches */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }} role="radiogroup" aria-label="Accent Color">
        {ACCENT_COLORS.map((c) => (
          <button
            key={c.id}
            type="button"
            role="radio"
            aria-checked={accent === c.id}
            aria-label={c.label}
            title={c.label}
            onClick={() => handleAccentChange(c.id)}
            style={{
              width: '18px',
              height: '18px',
              borderRadius: 'var(--r-ui-radius-full)',
              backgroundColor: c.hex,
              border: accent === c.id ? '2px solid var(--r-ui-color-text-primary)' : '1px solid transparent',
              cursor: 'pointer',
              padding: 0,
              outline: 'none',
              transform: accent === c.id ? 'scale(1.15)' : 'scale(1)',
              transition: 'transform 0.15s ease, border 0.15s ease',
            }}
          />
        ))}
      </div>
    </div>
  );
}

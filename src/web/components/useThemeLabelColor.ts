import { useEffect, useState } from 'react';

function readComputedVar(name: string): string | null {
  if (typeof document === 'undefined') return null;

  const root = document.documentElement;
  if (!root || typeof globalThis.getComputedStyle !== 'function') return null;

  const color = globalThis.getComputedStyle(root).getPropertyValue(name).trim();
  return color || null;
}

function useComputedVar(name: string, fallback: string): string {
  const [value, setValue] = useState(fallback);

  useEffect(() => {
    const root = typeof document !== 'undefined' ? document.documentElement : null;
    const read = () => {
      const color = readComputedVar(name);
      if (color) setValue(color);
    };

    read();

    if (!root || typeof globalThis.MutationObserver !== 'function') {
      return undefined;
    }

    const observer = new globalThis.MutationObserver(read);
    observer.observe(root, { attributes: true, attributeFilter: ['data-theme'] });
    return () => observer.disconnect();
  }, [name]);

  return value;
}

export function useThemeLabelColor(fallback = '#9ca3af'): string {
  return useComputedVar('--color-text-secondary', fallback);
}

/**
 * Resolve any CSS custom property to its computed value, re-reading on theme
 * switch. VChart parses spec colors with its own engine — it cannot resolve
 * `var(--…)` strings, which silently fall back to white/invisible on the light
 * theme. Pass the resolved value into chart specs instead.
 */
export function useThemeVar(name: string, fallback: string): string {
  return useComputedVar(name, fallback);
}

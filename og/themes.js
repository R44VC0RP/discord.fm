/**
 * Per-skin OG image themes. Keyed by skin filename (without .html) as found
 * in web/skins/. Unknown skins fall back to DEFAULT_THEME so a new skin never
 * breaks OG generation — add a palette here when adding a skin (optional).
 *
 * A theme only carries design tokens; the layout lives in generator.js.
 */

export const DEFAULT_THEME = 'classic-receiver';

export const THEMES = {
  // Warm paper + teal, pixel lettering (station brand).
  'classic-receiver': {
    bg: '#d9c3a9',
    bgGradient: null,
    panel: '#efe0cc',
    panelBorder: '#17140f',
    panelRadius: 34,
    ink: '#17140f',
    dim: '#8a7458',
    accent: '#3e968f',
    chipBg: '#57b7b0',
    chipText: '#17140f',
    live: '#3e968f',
    offair: '#8a7458',
    wordmarkFont: 'Pixelify Sans',
    bodyFont: 'Pixelify Sans',
    numberFont: 'Inter',
    prompt: '',
  },

  // Green phosphor terminal.
  'midnight-console': {
    bg: '#0a0f0a',
    bgGradient: 'linear-gradient(180deg, #101a10 0%, #0a0f0a 80%)',
    panel: 'rgba(6, 12, 6, 0.6)',
    panelBorder: '#2e7a2e',
    panelRadius: 8,
    ink: '#6ee76e',
    dim: '#2e7a2e',
    accent: '#6ee76e',
    chipBg: '#0a0f0a',
    chipText: '#6ee76e',
    chipBorder: '#2e7a2e',
    live: '#ffb45a',
    offair: '#2e7a2e',
    wordmarkFont: 'VT323',
    bodyFont: 'VT323',
    numberFont: 'VT323',
    prompt: '> ',
  },

  // Brushed steel deck with navy LCD.
  'steel-deck': {
    bg: '#0b0d13',
    bgGradient: 'linear-gradient(180deg, #1d2230 0%, #0b0d13 85%)',
    panel: '#050a14',
    panelBorder: '#35415f',
    panelRadius: 12,
    ink: '#8dfa3c',
    dim: '#56607a',
    accent: '#5db8ff',
    chipBg: '#232c44',
    chipText: '#8dfa3c',
    chipBorder: '#35415f',
    live: '#ffb347',
    offair: '#56607a',
    wordmarkFont: 'VT323',
    bodyFont: 'VT323',
    numberFont: 'VT323',
    wordmarkColor: '#d8dde4',
    prompt: '',
  },
};

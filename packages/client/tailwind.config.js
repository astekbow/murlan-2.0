/** @type {import('tailwindcss').Config} */
// "Midnight Mint" brand (rebrand 2026-11): midnight navy, one mint action accent,
// amber for money, sea-teal felt. Mirrored as CSS variables in
// index.css (:root) so both Tailwind utilities and the component classes agree.
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      // "Obsidian & Gold" — mirrors the CSS vars in index.css :root (kept as hex so
      // Tailwind's /opacity modifiers keep working). The game-table felt stays warm.
      colors: {
        // "Midnight Mint" (rebrand 2026-11) — mirrors the CSS vars in index.css :root (hex so the
        // /opacity modifiers keep working). Legacy NAMES kept: `gold` is now the MINT accent.
        bg0: '#08101C',
        bg1: '#0D1726',
        maroon: '#123B3A',
        felt: { DEFAULT: '#145A66', hi: '#1F7C86', edge: '#0C3A45' },
        gold: { DEFAULT: '#34D399', hi: '#6EE7B7', deep: '#1FA97A', line: '#2BB886' },
        amber: { DEFAULT: '#FBBF5A', hi: '#FCD38D', ink: '#2A1A02' },
        navy: { DEFAULT: '#14223A', hi: '#1B2D4A', deep: '#0F1A2C' },
        bulb: '#FBBF5A',
        royal: '#7C9CF5', // player ring: idle
        emerald2: '#34D399', // player ring: active / last-played
        cream: '#FFFFFF',
        ink: '#0F172A',
        suit: '#D92D3A', // suit red on cards
        txt: { DEFAULT: '#D3DCEA', hi: '#EEF3FB', lo: '#A9B6CB' },
        muted: '#A9B6CB', // ≥ 4.5:1 on the midnight base (WCAG AA)
        // Semantic (chrome).
        success: '#34D399',
        danger: '#F87171',
        info: '#7C9CF5',
        live: '#FB923C',
      },
      fontFamily: {
        // ONE family for the whole brand: Plus Jakarta Sans (800 titles · 700 labels · 500 body).
        display: ['Plus Jakarta Sans', 'system-ui', 'sans-serif'],
        serif: ['Plus Jakarta Sans', 'system-ui', 'sans-serif'],
        sans: ['Plus Jakarta Sans', 'system-ui', 'Segoe UI', 'sans-serif'],
      },
      borderRadius: {
        table: '134px / 90px',
        xs: 'var(--r-xs)', sm: 'var(--r-sm)', md: 'var(--r-md)', lg: 'var(--r-lg)',
        xl: 'var(--r-xl)', '2xl': 'var(--r-2xl)', '3xl': 'var(--r-3xl)', pill: 'var(--r-pill)',
      },
      boxShadow: {
        panel: 'var(--e4)',
        gold: '0 8px 18px -8px rgba(232,200,121,.7)',
        glow: 'var(--glow-gold)',
        e1: 'var(--e1)', e2: 'var(--e2)', e3: 'var(--e3)', e4: 'var(--e4)', e5: 'var(--e5)',
      },
      fontSize: {
        'fluid-2xs': 'var(--fs-2xs)', 'fluid-xs': 'var(--fs-xs)', 'fluid-sm': 'var(--fs-sm)',
        'fluid-base': 'var(--fs-base)', 'fluid-lg': 'var(--fs-lg)', 'fluid-xl': 'var(--fs-xl)',
        'fluid-2xl': 'var(--fs-2xl)', 'fluid-display': 'var(--fs-display)',
      },
      zIndex: { content: '10', sticky: '20', overlay: '30', modal: '50', toast: '60', tooltip: '70' },
      keyframes: {
        rise: {
          '0%': { opacity: '0', transform: 'translateY(14px)' },
          '100%': { opacity: '1', transform: 'none' },
        },
        twinkle: { '0%,100%': { opacity: '1' }, '50%': { opacity: '.3' } },
        spin360: { to: { transform: 'rotate(360deg)' } },
        dealIn: {
          '0%': { transform: 'translateY(-40px) scale(0.6)', opacity: '0' },
          '100%': { transform: 'translateY(0) scale(1)', opacity: '1' },
        },
        shuffle: {
          '0%,100%': { transform: 'translateX(0) rotate(0deg)' },
          '25%': { transform: 'translateX(-8px) rotate(-6deg)' },
          '75%': { transform: 'translateX(8px) rotate(6deg)' },
        },
        pop: {
          '0%': { transform: 'scale(0.8)', opacity: '0' },
          '100%': { transform: 'scale(1)', opacity: '1' },
        },
      },
      animation: {
        rise: 'rise .5s ease both',
        twinkle: 'twinkle 2.6s infinite',
        spin360: 'spin360 8s linear infinite',
        dealIn: 'dealIn 350ms ease-out both',
        shuffle: 'shuffle 500ms ease-in-out infinite',
        pop: 'pop 180ms ease-out both',
      },
    },
  },
  plugins: [],
};

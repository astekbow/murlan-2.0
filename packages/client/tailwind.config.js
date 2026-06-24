/** @type {import('tailwindcss').Config} */
// Premium "card-club" theme extracted from murlan-mockup-v2.html: deep
// maroon→black, warm red felt, ornate glowing gold. Mirrored as CSS variables in
// index.css (:root) so both Tailwind utilities and the component classes agree.
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      // "Obsidian & Gold" — mirrors the CSS vars in index.css :root (kept as hex so
      // Tailwind's /opacity modifiers keep working). The game-table felt stays warm.
      colors: {
        bg0: '#0b0a0e',
        bg1: '#131119',
        maroon: '#3a0f16',
        felt: { DEFAULT: '#7c1620', hi: '#94202b', edge: '#330a0e' },
        gold: { DEFAULT: '#e8c879', hi: '#fff3cf', deep: '#a9842f', line: '#c9a14d' },
        bulb: '#ffe6a3',
        royal: '#3f6fd6', // player ring: idle
        emerald2: '#34c46a', // player ring: active / last-played
        cream: '#fbfaf5',
        ink: '#14110c',
        suit: '#c21f1f', // suit red on cards
        txt: { DEFAULT: '#d9d2c6', hi: '#f6f1e8', lo: '#b8b0c8' },
        muted: '#b8b0c8', // = --muted in index.css; ≈5.6:1 on the dark base (WCAG AA). Was #9c96a6 (≈4.0:1, failed).
        // Semantic (chrome).
        success: '#34d39a',
        danger: '#ff5d5d',
        info: '#5b8cff',
        live: '#ff7a4d',
      },
      fontFamily: {
        display: ['Oswald', 'system-ui', 'sans-serif'], // game titles / labels
        serif: ['Cinzel', 'Georgia', 'serif'], // crests / headers
        sans: ['Outfit', 'system-ui', 'Segoe UI', 'sans-serif'], // body
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

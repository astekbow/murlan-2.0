/** @type {import('tailwindcss').Config} */
// Premium "card-club" theme extracted from murlan-mockup-v2.html: deep
// maroon→black, warm red felt, ornate glowing gold. Mirrored as CSS variables in
// index.css (:root) so both Tailwind utilities and the component classes agree.
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        bg0: '#160407',
        bg1: '#2a080c',
        maroon: '#4d0c12',
        // `light`/`dark` are on-theme aliases so table components not yet rebuilt
        // (Phase 3) still render warm-red felt instead of a missing class.
        felt: { DEFAULT: '#7c1620', hi: '#94202b', edge: '#330a0e', light: '#94202b', dark: '#330a0e' },
        gold: { DEFAULT: '#e6c570', hi: '#fff1c4', deep: '#9a7528', line: '#c9a14d' },
        bulb: '#ffe6a3',
        royal: '#3f6fd6', // player ring: idle
        emerald2: '#34c46a', // player ring: active / last-played
        cream: '#fbfaf5',
        ink: '#14110c',
        suit: '#c21f1f', // suit red on cards
        txt: '#f0e7d4',
        muted: '#c39a93',
        // Legacy aliases kept so untouched views still compile during the reskin.
        team1: '#3f6fd6',
        team2: '#c21f1f',
      },
      fontFamily: {
        display: ['Oswald', 'system-ui', 'sans-serif'], // game titles / labels
        serif: ['Cinzel', 'Georgia', 'serif'], // crests / headers
        sans: ['Outfit', 'system-ui', 'Segoe UI', 'sans-serif'], // body
      },
      borderRadius: { table: '134px / 90px' },
      boxShadow: {
        panel: '0 26px 60px -24px #000, inset 0 1px 0 rgba(255,255,255,.12)',
        gold: '0 8px 18px -8px rgba(230,197,112,.7)',
        glow: '0 0 26px rgba(230,197,112,.3)',
      },
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

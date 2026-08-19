/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        /* The grass field of the board */
        board: {
          50:  '#f4fbee',
          100: '#e6f5d9',
          200: '#d2ecbe',
          300: '#b9e09c',
          400: '#9ed07a',
          500: '#81bb59',
          600: '#659e41',
          700: '#4e7c34',
          800: '#3f632d',
          900: '#345027',
        },
        /* The winding path + paper stock */
        parchment: {
          DEFAULT: '#fffcf2',
          50:  '#fffef9',
          100: '#fff8e6',
          200: '#fbf0c8',
          300: '#f6e3a2',
          400: '#eed26f',
        },
        /* Photo-frame red from the polaroid borders */
        crimson: {
          300: '#e58194',
          400: '#cd4a60',
          500: '#b22f45',
          600: '#9e2436',
          700: '#7f1828',
          800: '#5f101d',
        },
        /* Board bezel / marker ink */
        ink: {
          400: '#5a6779',
          500: '#3f4b5e',
          600: '#2c3749',
          700: '#1f2938',
          800: '#17202e',
          900: '#0f1722',
        },
        /* The scattered pickup tokens: +10, -10, !, potion */
        pip: {
          cyan:   '#33c6e8',
          red:    '#e8402f',
          gold:   '#ffce2e',
          leaf:   '#46c458',
          violet: '#8b6fe8',
        },
      },
      fontFamily: {
        display: ['"Baloo 2"', 'ui-rounded', 'system-ui', 'sans-serif'],
        sans: ['Nunito', 'ui-sans-serif', 'system-ui', 'sans-serif'],
        mono: ['"Space Mono"', 'ui-monospace', 'monospace'],
      },
      borderRadius: {
        board: '1.5rem',
      },
      boxShadow: {
        /* Hard, printed-sticker drop shadows — no blur */
        'sticker-sm': '0 3px 0 0 #0f1722',
        sticker:      '0 4px 0 0 #0f1722',
        'sticker-lg': '0 6px 0 0 #0f1722, 0 16px 26px -12px rgba(15,23,34,.45)',
        frame:        '0 5px 0 0 #7f1828, 0 16px 24px -14px rgba(15,23,34,.55)',
        token:        '0 3px 0 0 rgba(15,23,34,.30)',
        pressed:      '0 0 0 0 #0f1722',
      },
      keyframes: {
        pop: {
          '0%':   { transform: 'scale(.82)', opacity: '0' },
          '60%':  { transform: 'scale(1.05)', opacity: '1' },
          '100%': { transform: 'scale(1)', opacity: '1' },
        },
        shake: {
          '0%,100%':  { transform: 'translateX(0)' },
          '20%,60%':  { transform: 'translateX(-5px)' },
          '40%,80%':  { transform: 'translateX(5px)' },
        },
        bob: {
          '0%,100%': { transform: 'translateY(0)' },
          '50%':     { transform: 'translateY(-4px)' },
        },
        wiggle: {
          '0%,100%': { transform: 'rotate(-2.5deg)' },
          '50%':     { transform: 'rotate(2.5deg)' },
        },
        'dash-march': {
          to: { backgroundPosition: '48px 0' },
        },
      },
      animation: {
        pop: 'pop .28s cubic-bezier(.34,1.56,.64,1) both',
        shake: 'shake .4s ease-in-out',
        bob: 'bob 1.8s ease-in-out infinite',
        wiggle: 'wiggle 1.4s ease-in-out infinite',
        'dash-march': 'dash-march 1.2s linear infinite',
      },
      aspectRatio: {
        '3/4': '3 / 4',
      },
    },
  },
  plugins: [],
}

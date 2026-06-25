/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        // Gold-on-dark theme (visual inspiration only — no brand naming)
        ink: {
          900: '#0E0F12',
          800: '#16181D',
          700: '#1E2127',
          600: '#272B33',
          500: '#343943',
        },
        gold: {
          50: '#FBF3DF',
          100: '#F6E6BE',
          200: '#F2C879',
          300: '#E5B25D',
          400: '#D49A3E',
          500: '#B87E29',
          600: '#8C5E1C',
        },
        cream: '#F4ECDD',
        mute: '#9AA0AC',
      },
      fontFamily: {
        sans: ['Inter', 'system-ui', '-apple-system', 'Segoe UI', 'Roboto', 'sans-serif'],
        mono: ['"JetBrains Mono"', 'ui-monospace', 'SFMono-Regular', 'Menlo', 'monospace'],
      },
      boxShadow: {
        glow: '0 0 0 1px rgba(229,178,93,0.35), 0 0 24px rgba(229,178,93,0.25)',
        panel: '0 1px 0 rgba(255,255,255,0.03) inset, 0 8px 30px rgba(0,0,0,0.45)',
      },
      keyframes: {
        'fade-up': {
          '0%': { opacity: '0', transform: 'translateY(6px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' },
        },
        'pulse-glow': {
          '0%,100%': { filter: 'drop-shadow(0 0 2px rgba(242,200,121,0.4))' },
          '50%': { filter: 'drop-shadow(0 0 10px rgba(242,200,121,0.85))' },
        },
        shimmer: {
          '0%': { backgroundPosition: '-200% 0' },
          '100%': { backgroundPosition: '200% 0' },
        },
      },
      animation: {
        'fade-up': 'fade-up 0.4s cubic-bezier(0.22,1,0.36,1) both',
        'pulse-glow': 'pulse-glow 1.6s ease-in-out infinite',
        shimmer: 'shimmer 2.5s linear infinite',
      },
    },
  },
  plugins: [],
};

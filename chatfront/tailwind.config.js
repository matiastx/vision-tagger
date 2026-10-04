/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        eva: {
          primary: {
            DEFAULT: '#7C5CFC',
            light: '#9A7FFC',
            dark: '#5E3FD9',
          },
          background: '#0E0B16',
          surface: '#16121F',
          'surface-alt': '#1E1930',
          border: {
            DEFAULT: '#2A2440',
            light: '#3A3258',
          },
          text: {
            DEFAULT: '#F0EDFA',
            muted: '#A79FC7',
            faint: '#6E6589',
          },
          success: '#4ADE80',
          error: '#F87171',
          warning: '#FBBF24',
          info: '#60A5FA',
        },
      },
    },
  },
  plugins: [],
}

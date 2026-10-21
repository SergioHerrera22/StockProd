/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        brand: {
          50: '#f0f6fb',
          100: '#dcecf7',
          200: '#b8d8ef',
          300: '#8abce2',
          400: '#5a9bd2',
          500: '#3a7db8',
          600: '#2c6396',
          700: '#254f78',
          800: '#1f3f5f',
          900: '#1a334c',
          950: '#122236',
        },
      },
      fontFamily: {
        sans: ['Inter', 'Segoe UI', 'system-ui', 'sans-serif'],
      },
    },
  },
  plugins: [],
};

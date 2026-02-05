
/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./components/**/*.{js,ts,jsx,tsx}",
    "./*.{js,ts,jsx,tsx}", // Matches root files like App.tsx, index.tsx, but ignores node_modules
  ],
  theme: {
    extend: {
      fontFamily: {
        sans: ['Inter', 'sans-serif'],
        display: ['Space Grotesk', 'sans-serif'],
      },
      backgroundSize: {
        '300%': '300%',
      },
      colors: {
        cream: '#FDFDF9',
        stone: {
          50: '#F7F7F5',
          100: '#EFEFED',
          200: '#E0E0DC',
          800: '#292524',
          900: '#1C1917',
        },
        sage: {
          50: '#F4F7F5',
          100: '#E3EBE6',
          200: '#C5D6CC',
          300: '#A3C0B0',
          400: '#82AA96',
          500: '#64947F',
          600: '#4D7563',
          700: '#3A574A',
          800: '#2A3E36',
          900: '#1C2924',
        },
        forest: {
          DEFAULT: '#1F3A2F',
          light: '#2C4F41',
          dark: '#14261F'
        },
        accent: {
          orange: '#E89D6B',
          yellow: '#FCD34D',
          purple: '#A855F7'
        }
      },
      animation: {
        'pulse-slow': 'pulse 3s cubic-bezier(0.4, 0, 0.6, 1) infinite',
        'slide-down': 'slideDown 0.3s ease-out forwards',
        'slide-up': 'slideUp 0.5s ease-out forwards',
        'fade-in': 'fadeIn 0.5s ease-out forwards',
        'blob': 'blob 10s infinite',
        'typing': 'typing 3.5s steps(40, end)',
        'gradient': 'gradient 8s ease infinite',
      },
      keyframes: {
        slideDown: {
          '0%': { transform: 'translateY(-100%)', opacity: '0' },
          '100%': { transform: 'translateY(0)', opacity: '1' },
        },
        slideUp: {
          '0%': { transform: 'translateY(20px)', opacity: '0' },
          '100%': { transform: 'translateY(0)', opacity: '1' },
        },
        fadeIn: {
          '0%': { opacity: '0' },
          '100%': { opacity: '1' },
        },
        blob: {
          '0%': { transform: 'translate(0px, 0px) scale(1)' },
          '33%': { transform: 'translate(30px, -50px) scale(1.1)' },
          '66%': { transform: 'translate(-20px, 20px) scale(0.9)' },
          '100%': { transform: 'translate(0px, 0px) scale(1)' },
        },
        gradient: {
          '0%': { backgroundPosition: '0% 50%' },
          '50%': { backgroundPosition: '100% 50%' },
          '100%': { backgroundPosition: '0% 50%' },
        }
      }
    }
  },
  plugins: [],
}
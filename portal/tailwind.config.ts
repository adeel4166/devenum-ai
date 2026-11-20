import type { Config } from "tailwindcss";
import colors from "tailwindcss/colors";

/**
 * Claude-inspired dark theme: warm charcoal surfaces, coral/amber accent.
 * `slate` is remapped to the warm `stone` scale so every existing slate-* utility picks up the warmer greys.
 */
const config: Config = {
  content: ["./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        slate: colors.stone,
        ink: { 950: "#141413", 900: "#1a1a18", 800: "#21211f", 700: "#2a2926", 600: "#3a3935" },
        brand: { DEFAULT: "#d97757", soft: "#e8936f", deep: "#c0603f" },
        amberx: { DEFAULT: "#f0a35e" },
      },
      fontFamily: {
        sans: ["ui-sans-serif", "system-ui", "-apple-system", "Segoe UI", "Inter", "Roboto", "Helvetica Neue", "Arial", "sans-serif"],
        mono: ["ui-monospace", "SFMono-Regular", "Menlo", "Consolas", "Liberation Mono", "monospace"],
      },
      boxShadow: { glow: "0 0 0 1px rgba(217,119,87,.35), 0 8px 40px -12px rgba(217,119,87,.35)" },
    },
  },
  plugins: [],
};
export default config;

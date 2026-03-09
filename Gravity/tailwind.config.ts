import type { Config } from "tailwindcss";

const config = {
  content: ["./index.html", "./src/**/*.{ts,tsx,js,jsx}"],
  theme: {
    extend: {
      colors: {
        primary: "#344979",
        secondary: "#5d6da5",
        mid: "#9896bb",
        soft: "#c6c6e8",
        blush: "#f7e5eb",
        ink: "#1e243a",
      },
      fontFamily: {
        ui: ["Nunito", "sans-serif"],
        body: ["Lora", "serif"],
      },
    },
  },
  plugins: [],
} satisfies Config;

export default config;

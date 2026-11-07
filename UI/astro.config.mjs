// @ts-check
import { defineConfig } from "astro/config";

import react from "@astrojs/react";
import tailwindcss from "@tailwindcss/vite";

// Static build to UI/dist, served by the "tincan" Worker at tincan.devh.in.
// Point it at the signaling server with PUBLIC_WS_URL (defaults to wss://p2p.devh.in/ws).
export default defineConfig({
  site: "https://tincan.devh.in",
  trailingSlash: "always",
  integrations: [react()],
  vite: {
    plugins: [tailwindcss()],
  },
});

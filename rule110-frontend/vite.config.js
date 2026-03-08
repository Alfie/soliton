import { defineConfig } from 'vite'
import elm from 'vite-plugin-elm'
import { nodePolyfills } from 'vite-plugin-node-polyfills'

export default defineConfig({
  plugins: [
    elm({
      optimize: false,  // set true for production builds
    }),
    nodePolyfills({
      include: ['buffer'],
      globals: { Buffer: true },
    }),
  ],

  // Vite needs to know @solana/kit uses top-level await
  optimizeDeps: {
    exclude: ['@solana/kit'],
  },

  build: {
    target: 'esnext',   // required for top-level await in @solana/kit
  },

  server: {
    port: 3000,
  },
})

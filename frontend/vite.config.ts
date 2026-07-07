import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

// https://vite.dev/config/  (Vitest config merged in via `vitest/config`)
export default defineConfig({
  plugins: [react()],
  build: {
    // Output to 'build' to match firebase.json hosting.public ('frontend/build').
    outDir: 'build',
    // 'hidden' emits source maps (for CI/error tracking) but adds no
    // sourceMappingURL comment, so browsers don't auto-fetch them; firebase.json
    // also excludes **/*.map from the deployed bundle.
    sourcemap: 'hidden',
  },
  worker: {
    // The ZK proving worker imports snarkjs as an ES module; emit an ESM worker
    // so `new Worker(new URL(...), { type: 'module' })` bundles correctly.
    format: 'es',
  },
  server: {
    port: 3000,
    // Dev-only proxy: when VITE_API_BASE_URL is the default "/api",
    // forward API calls to the local Rust backend. Harmless when an absolute
    // API base URL is configured (those requests bypass the proxy).
    proxy: {
      '/api': {
        target: process.env.VITE_DEV_API_PROXY || 'http://localhost:8080',
        changeOrigin: true,
      },
    },
  },
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: './src/setupTests.ts',
  },
});

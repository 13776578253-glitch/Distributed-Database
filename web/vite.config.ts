/** Builds the browser bundle independently of the Node.js observer. */
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  build: { outDir: '../dist/console', emptyOutDir: true },
});

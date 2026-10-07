import { defineConfig } from 'vite';

// Tauri expects a fixed dev port and serves the built files from ./dist.
export default defineConfig({
  root: '.',
  clearScreen: false,
  server: { port: 1420, strictPort: true, watch: { ignored: ['**/src-tauri/**'] } },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    target: ['es2022', 'chrome110', 'safari16'],
    minify: 'esbuild',
    sourcemap: false,
    reportCompressedSize: false,
    // demo.html renders the overlay above a mock desktop (README visuals / showcase).
    rollupOptions: { input: { main: 'index.html', demo: 'demo.html' } },
    chunkSizeWarningLimit: 900,
  },
  esbuild: { legalComments: 'none' },
});

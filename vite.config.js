import { defineConfig } from 'vite';

// ARTIFACT=1 produces a single-file build: one JS module, one stylesheet, no
// public/ copy. scripts/build-artifact.mjs then inlines both, plus every
// asset as base64, into one self-contained HTML page.
const ARTIFACT = Boolean(process.env.ARTIFACT);

export default defineConfig({
  base: './',
  publicDir: ARTIFACT ? false : 'public',
  server: { host: true, port: 5173 },
  build: {
    target: 'es2022',
    outDir: ARTIFACT ? 'dist-artifact' : 'dist',
    assetsInlineLimit: 0,
    cssCodeSplit: false,
    chunkSizeWarningLimit: 1600,
    rollupOptions: {
      output: ARTIFACT
        ? {
            inlineDynamicImports: true,
            entryFileNames: 'app.js',
            assetFileNames: 'app.[ext]',
          }
        : {
            manualChunks: {
              three: ['three'],
              post: ['postprocessing', 'n8ao'],
            },
          },
    },
  },
});

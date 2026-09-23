import { defineConfig } from 'vite';

export default defineConfig({
  base: '/hub/',
  build: {
    assetsDir: 'assets',
    outDir: 'dist',
  },
});

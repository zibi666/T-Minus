import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Electron 以 file:// 加载产物，必须 base:'./'
export default defineConfig({
  base: './',
  plugins: [react()],
  build: {
    outDir: 'dist/renderer',
    emptyOutDir: true
  }
});

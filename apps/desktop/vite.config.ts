import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// `base: './'` para o index.html abrir via file:// dentro do Electron.
export default defineConfig({
  base: './',
  plugins: [react()],
  server: { port: 5290, strictPort: true },
  build: { outDir: 'dist', sourcemap: false },
});

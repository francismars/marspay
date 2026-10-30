import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import path from 'path';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  base: '/dashboard/',
  build: {
    outDir: path.resolve(import.meta.dirname, '../public/admin'),
    emptyOutDir: true,
  },
  server: {
    proxy: {
      '/dashboard/api': 'http://localhost:3001',
    },
  },
});

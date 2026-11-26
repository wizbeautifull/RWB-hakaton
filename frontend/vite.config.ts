import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, '.', 'MESH_');
  const proxy = { '/api': env.MESH_API_TARGET || 'http://127.0.0.1:8000' };
  const input = ['index.html', 'pvz/index.html', 'seller/index.html'];
  return { plugins: [react()], base: './', build: { rolldownOptions: { input } }, server: { proxy }, preview: { proxy } };
});

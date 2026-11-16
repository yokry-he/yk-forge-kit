import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';

export default defineConfig({
  plugins: [vue()],
  // API listens on IPv4 loopback; using `localhost` may resolve to ::1 and fail.
  server: { proxy: { '/api': { target: 'http://127.0.0.1:3001', changeOrigin: true } } },
});

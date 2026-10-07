import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';

const server = process.env.TWIN_SERVER ?? 'http://localhost:5080';

export default defineConfig({
  server: {
    port: 5173,
    proxy: {
      '/api': server,
      '/ws': { target: server.replace(/^http/, 'ws'), ws: true },
    },
    fs: { allow: [resolve(__dirname, '..')] },
  },
  build: {
    outDir: resolve(__dirname, '../server/src/TwinLabs.Api/wwwroot'),
    emptyOutDir: true,
    chunkSizeWarningLimit: 1200,
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});

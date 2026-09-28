import { defineConfig } from 'vitest/config';

// The window's tests: plain logic, apart from the dev server (vite.config.ts hands its pages the daemon's secret).
export default defineConfig({ test: { include: ['test/**/*.test.ts'] } });

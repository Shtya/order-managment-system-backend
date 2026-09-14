/// <reference types="vitest/globals" />
import { resolve } from 'node:path';
import swc from 'unplugin-swc';
import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    root: './',
    exclude: [...configDefaults.exclude],
    restoreMocks: true,
    mockReset: true
  },
  plugins: [
    // This is required to build the test files with SWC
    swc.vite({
      // Explicitly set the module type to avoid inheriting this value from a `.swcrc` config file
      module: { type: 'es6' },
    }),
  ],
  resolve: {
    alias: {
      "@src": resolve(process.cwd(), './src'),
      "@test": resolve(process.cwd(), './test'),
      src: resolve(process.cwd(), './src'),
      entities: resolve(process.cwd(), './entities'),
      common: resolve(process.cwd(), './common'),
      dto: resolve(process.cwd(), './dto'),
    },
  },
});

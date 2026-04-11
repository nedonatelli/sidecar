import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.test.ts'],
    exclude: ['src/test/integration/**'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.test.ts', 'src/webview/chatWebview.ts'],
    },
    alias: {
      vscode: new URL('./src/__mocks__/vscode.ts', import.meta.url).pathname,
    },
  },
});

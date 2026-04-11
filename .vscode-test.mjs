import { defineConfig } from '@vscode/test-cli';

export default defineConfig({
  files: 'out/src/test/integration/**/*.test.js',
  extensionDevelopmentPath: '.',
  workspaceFolder: '.',
  mocha: {
    timeout: 30000,
  },
});

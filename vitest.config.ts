import { defineConfig } from 'vitest/config';
import path from 'node:path';

export default defineConfig({
  resolve: {
    alias: {
      vscode: path.resolve(__dirname, 'src/test/__mocks__/vscode.ts'),
    },
  },
  test: {
    environment: 'node',
    include: ['src/test/**/*.test.ts'],
    passWithNoTests: true
  }
});
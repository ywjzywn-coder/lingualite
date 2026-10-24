import { defineConfig } from 'vitest/config';

export default defineConfig({
  // __DEV__ 由 esbuild 在构建时注入，测试环境需要给出同样的定义。
  define: { __DEV__: 'false' },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
  },
});

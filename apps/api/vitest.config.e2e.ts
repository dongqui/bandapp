import { defineConfig } from 'vitest/config';
import tsconfigPaths from 'vite-tsconfig-paths';

export default defineConfig({
  plugins: [tsconfigPaths()],
  test: {
    globals: true,
    root: './',
    include: ['**/*.e2e-spec.ts'],
    env: {
      DATABASE_URL: process.env.DATABASE_URL ?? 'postgresql://band:band@localhost:5432/band',
      JWT_ACCESS_SECRET: process.env.JWT_ACCESS_SECRET ?? 'e2e-test-secret',
      INVITE_LINK_BASE_URL: process.env.INVITE_LINK_BASE_URL ?? 'https://invite.test',
      AUTH_THROTTLE_LIMIT: '1000',
      DEV_LOGIN_SECRET: 'e2e-dev-secret',
    },
    globalSetup: ['./test/global-setup.ts'],
    // e2e spec files share one real Postgres database and truncate it in beforeEach,
    // so files must not run in parallel or they'll race each other's data.
    fileParallelism: false,
  },
});

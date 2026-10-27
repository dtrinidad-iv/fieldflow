import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    setupFiles: ['tests/setup.js'],
    // Never let tests pick up real credentials from the shell or ~/.aws.
    env: {
      TADABASE_APP_ID: '',
      TADABASE_APP_KEY: '',
      TADABASE_APP_SECRET: '',
      WEBHOOK_SECRET: '',
      FIELDFLOW_ALLOW_LIVE_WRITES: '',
      AWS_PROFILE: '',
      AWS_DEFAULT_PROFILE: '',
      AWS_ACCESS_KEY_ID: '',
      AWS_SECRET_ACCESS_KEY: '',
      AWS_SESSION_TOKEN: '',
      AWS_SHARED_CREDENTIALS_FILE: '/dev/null',
      AWS_CONFIG_FILE: '/dev/null',
      AWS_EC2_METADATA_DISABLED: 'true',
    },
    coverage: {
      provider: 'v8',
      include: ['functions/**/*.js', 'lib/**/*.js', 'widgets/**/*.js'],
      thresholds: { lines: 80, functions: 80, branches: 75, statements: 80 },
    },
  },
});

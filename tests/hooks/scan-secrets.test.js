// scripts/scan-secrets.sh runs in the pre-commit hook and CI. These tests plant fake secrets in a
// throwaway git repo and check that both modes catch them. The fake values are assembled at run
// time so this file never matches the scan itself.
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const fake = (prefix, length, alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567') =>
  prefix + Array.from({ length }, (_, i) => alphabet[(i * 7) % alphabet.length]).join('');

function repoWith(files) {
  const dir = mkdtempSync(path.join(tmpdir(), 'ff-scan-'));
  const git = (...args) => spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
  git('init', '-q');
  mkdirSync(path.join(dir, 'scripts'));
  copyFileSync(path.join(root, 'scripts/scan-secrets.sh'), path.join(dir, 'scripts/scan-secrets.sh'));
  for (const [name, content] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    writeFileSync(path.join(dir, name), content);
  }
  const scan = (...args) => spawnSync('bash', ['scripts/scan-secrets.sh', ...args], { cwd: dir, encoding: 'utf8' });
  return { git, scan };
}

const awsKey = fake('AKIA', 16);
const tadabaseSecret = fake('', 24, 'abcdefghijkLMNOPQRSTuvwxyz0123456789');

describe('scan-secrets', () => {
  it.each([
    ['an AWS access key', 'lib/config.js', `export const key = "${awsKey}";\n`],
    ['an AWS temporary key', 'lib/config.js', `const k = '${fake('ASIA', 16)}';\n`],
    ['an AWS secret key in config form', 'config/aws.ini', `aws_secret_access_key = ${fake('', 40, 'abcdefghijKLMNOPQRST0123456789+/')}\n`],
    ['an unquoted Tadabase secret', 'scripts/run.sh', `TADABASE_APP_SECRET=${tadabaseSecret}\n`],
    ['a Tadabase key as a YAML default', 'template.yaml', `TadabaseAppKey: ${tadabaseSecret}\n`],
    ['a key in a test fixture', 'tests/fixtures/x.js', `const apiKey = "${tadabaseSecret}";\n`],
    ['a GitHub token', 'notes.md', `${fake('ghp_', 36, 'abcdefghijklmnopqrstuvwxyz0123456789')}\n`],
  ])('finds %s in untracked files before the first commit', (_, name, content) => {
    const { scan } = repoWith({ [name]: content });
    const result = scan();
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/possible secrets found/);
  });

  it('masks the secret in its output', () => {
    const { scan } = repoWith({ 'lib/config.js': `export const key = "${awsKey}";\n` });
    const result = scan();
    expect(result.stderr).toContain('lib/config.js:1');
    expect(result.stderr).not.toContain(awsKey);
  });

  it('rejects a staged secret (the pre-commit hook mode)', () => {
    const { git, scan } = repoWith({ 'lib/config.js': `export const key = "${awsKey}";\n` });
    git('add', 'lib/config.js');
    expect(scan('--staged').status).toBe(1);
  });

  it.each(['.env', '.ENV.local', '.envrc', 'env.json'])('rejects a staged env file: %s', (name) => {
    const { git, scan } = repoWith({ [name]: 'X=1\n' });
    git('add', '-f', name);
    const result = scan('--staged');
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/env files are staged/);
  });

  it('passes a clean repo and .env.example with empty values', () => {
    const { scan } = repoWith({
      '.env.example': 'TADABASE_APP_KEY=\nTADABASE_APP_SECRET=\n',
      'lib/x.js': 'const token = process.env.TADABASE_APP_SECRET;\n',
      'vitest.config.js': "env: { AWS_SECRET_ACCESS_KEY: '' },\n",
    });
    const result = scan();
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
  });
});

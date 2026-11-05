import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

test('release guard rejects a tag that differs from the displayed app version', () => {
  const root = fileURLToPath(new URL('../', import.meta.url));
  const version = JSON.parse(readFileSync(new URL('../package.json', import.meta.url))).version;
  const check = (tag) => spawnSync(process.execPath, ['scripts/check-version.mjs'], {
    cwd: root, windowsHide: true, encoding: 'utf8', env: { ...process.env, RELEASE_TAG: tag },
  });
  assert.equal(check(`v${version}`).status, 0);
  const wrong = check('v0.0.0-invalid');
  assert.notEqual(wrong.status, 0);
  assert.match(wrong.stderr, /Release tag must match the app version/);
});

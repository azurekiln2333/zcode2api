import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// The unified deployment relies on image defaults: compose passes neither HOST
// nor PORT for zcode, maps 12283:12283 and the panel calls http://zcode:12283.
const root = fileURLToPath(new URL('../', import.meta.url));
const read = (file) => readFileSync(path.join(root, file), 'utf8');

const dockerfile = read('Dockerfile');

const envValue = (name) => {
  const match = dockerfile.match(new RegExp(`^ENV ${name}=(\\S+)$`, 'm'));
  return match ? match[1].trim() : null;
};

test('the image listens on 12283 by default so compose can omit PORT', () => {
  assert.equal(envValue('PORT'), '12283');
  assert.equal(envValue('HOST'), '0.0.0.0');
  assert.match(dockerfile, /^EXPOSE 12283$/m);
});

test('the image ships its own healthcheck that follows PORT', () => {
  const start = dockerfile.indexOf('HEALTHCHECK');
  assert.ok(start >= 0, 'Dockerfile must define HEALTHCHECK');
  // The block ends where the runtime CMD line begins.
  const end = dockerfile.indexOf('CMD ["node"', start);
  const block = dockerfile.slice(start, end > start ? end : undefined);
  assert.match(block, /127\.0\.0\.1/);
  assert.match(block, /\/health/);
  // Probing a hard-coded port would break the moment PORT is overridden.
  assert.match(block, /process\.env\.PORT/);
  assert.doesNotMatch(block, /127\.0\.0\.1:8787/);
});

test('the auth modules are shipped into the runtime image', () => {
  for (const file of ['zcgw-oidc.mjs', 'zcgw-sso.mjs']) {
    assert.ok(dockerfile.includes(file), `${file} must be copied into the image`);
  }
});

test('the release image check probes the port the image listens on', () => {
  // A hard-coded 8787 here broke the v1.2.0 release job after the default moved.
  const script = read('scripts/ci-image.sh');
  assert.match(script, /process\.env\.PORT/);
  assert.doesNotMatch(script, /127\.0\.0\.1:8787/);
});

test('the shipped compose no longer requires the dropped variables', () => {
  for (const file of ['docker-compose.yml', 'docker-compose.build.yml']) {
    const compose = read(file);
    // Code defaults stay; only the environment declarations go away.
    assert.doesNotMatch(compose, /GATEWAY_KEY/, `${file} must not set GATEWAY_KEY`);
    assert.doesNotMatch(compose, /ZCODE_UPSTREAM_ORIGIN/, `${file} must not set ZCODE_UPSTREAM_ORIGIN`);
    assert.doesNotMatch(compose, /ZCODE_MODEL/, `${file} must not set ZCODE_MODEL`);
    // The panel key replaces the old per-service token.
    assert.doesNotMatch(compose, /PLATFORM_TOKEN/, `${file} must not mention PLATFORM_TOKEN`);
  }
});

test('the shipped compose still pins 12283 explicitly for older images', () => {
  const compose = read('docker-compose.yml');
  assert.match(compose, /12283/);
});

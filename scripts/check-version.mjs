import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
const read = (file) => JSON.parse(readFileSync(new URL(`../${file}`, import.meta.url), 'utf8'));
const version = read('package.json').version;
const lock = read('web/package-lock.json');
for (const value of [read('web/package.json').version, lock.version, lock.packages[''].version]) {
  assert.equal(value, version, 'Root, console and lockfile versions must match');
}
const tag = process.env.RELEASE_TAG || (process.env.GITHUB_REF_TYPE === 'tag' ? process.env.GITHUB_REF_NAME : '');
if (tag) assert.equal(tag, `v${version}`, 'Release tag must match the app version');
console.log(`Version verified: ${version}`);

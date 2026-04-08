const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { loadConfig, clearCache, DEFAULTS } = require('../src/config');

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'fg-cfg-'));
}

test('config: no rc file → returns defaults', () => {
  clearCache();
  const dir = tmp();
  const cfg = loadConfig(dir);
  assert.equal(cfg.scarThreshold, DEFAULTS.scarThreshold);
  assert.deepEqual(cfg.ignore, []);
  assert.equal(cfg.blameConcurrency, 8);
});

test('config: user overrides are merged onto defaults', () => {
  clearCache();
  const dir = tmp();
  fs.writeFileSync(path.join(dir, '.fixguardrc.json'), JSON.stringify({
    scarThreshold: 0.70,
    ignore: ['legacy/**', 'vendor/**'],
    blameConcurrency: 16,
  }));
  const cfg = loadConfig(dir);
  assert.equal(cfg.scarThreshold, 0.70);
  assert.deepEqual(cfg.ignore, ['legacy/**', 'vendor/**']);
  assert.equal(cfg.blameConcurrency, 16);
  // Non-overridden fields still come from defaults
  assert.equal(cfg.maxFileBytes, DEFAULTS.maxFileBytes);
});

test('config: malformed rc → silently falls back to defaults', () => {
  clearCache();
  const dir = tmp();
  fs.writeFileSync(path.join(dir, '.fixguardrc.json'), 'this is not json');
  const cfg = loadConfig(dir);
  assert.equal(cfg.scarThreshold, DEFAULTS.scarThreshold);
});

test('config: non-array ignore is coerced to empty array', () => {
  clearCache();
  const dir = tmp();
  fs.writeFileSync(path.join(dir, '.fixguardrc.json'), JSON.stringify({
    ignore: 'not-an-array',
  }));
  const cfg = loadConfig(dir);
  assert.deepEqual(cfg.ignore, []);
});

test('config: cache is returned on second call', () => {
  clearCache();
  const dir = tmp();
  const a = loadConfig(dir);
  const b = loadConfig(dir);
  assert.strictEqual(a, b); // same reference
});

test('config: clearCache forces reload', () => {
  clearCache();
  const dir = tmp();
  const a = loadConfig(dir);
  clearCache();
  const b = loadConfig(dir);
  assert.notStrictEqual(a, b); // different references after clear
});

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { parseFile } = require('../src/markers');

function tmpFile(content, ext = '.js') {
  const p = path.join(os.tmpdir(), `fg-${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`);
  fs.writeFileSync(p, content);
  return p;
}

test('parses shorthand @fix marker', () => {
  const f = tmpFile(`// @fix [auth] "don't remove iat check"\nfunction a() {}\n`);
  const r = parseFile(f, os.tmpdir());
  assert.equal(r.length, 1);
  assert.equal(r[0].tag, 'auth');
  assert.equal(r[0].reason, "don't remove iat check");
  assert.equal(r[0].startLine, 1);
});

test('parses lines= override', () => {
  const f = tmpFile(`// @fix [x] lines=5 "reason"\n` + 'a\n'.repeat(20));
  const r = parseFile(f, os.tmpdir());
  assert.equal(r[0].endLine - r[0].startLine, 5);
});

test('parses fix-start / fix-end block', () => {
  const f = tmpFile(`// @fix-start [block] "explicit"\nlineA\nlineB\n// @fix-end\nafter\n`);
  const r = parseFile(f, os.tmpdir());
  assert.equal(r.length, 1);
  assert.equal(r[0].startLine, 1);
  assert.equal(r[0].endLine, 4);
});

test('parses python # comments', () => {
  const f = tmpFile(`# @fix [csrf] "no empty origin"\ndef a(): pass\n`, '.py');
  const r = parseFile(f, os.tmpdir());
  assert.equal(r.length, 1);
  assert.equal(r[0].tag, 'csrf');
});

test('handles file with no markers', () => {
  const f = tmpFile(`function a() { return 1; }\n`);
  const r = parseFile(f, os.tmpdir());
  assert.equal(r.length, 0);
});

test('unclosed fix-start protects to EOF', () => {
  const f = tmpFile(`// @fix-start [eof] "no end"\nline\nline\n`);
  const r = parseFile(f, os.tmpdir());
  assert.equal(r.length, 1);
  assert.ok(r[0].endLine >= 3);
});

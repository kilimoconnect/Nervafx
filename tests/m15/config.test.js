'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { CONFIG, CONFIG_VERSION, configHash, stableStringify } = require('../../api/_m15/config');

test('config exposes a version and it matches CONFIG.version', () => {
  assert.equal(typeof CONFIG_VERSION, 'string');
  assert.equal(CONFIG.version, CONFIG_VERSION);
});

test('configHash is deterministic and independent of key order', () => {
  const h1 = configHash(CONFIG);
  const h2 = configHash(CONFIG);
  assert.equal(h1, h2);
  // reorder keys ⇒ same stable string ⇒ same hash
  const reordered = { b: 2, a: 1 };
  const ordered = { a: 1, b: 2 };
  assert.equal(stableStringify(reordered), stableStringify(ordered));
});

test('changing a threshold changes the hash (reproducibility guard)', () => {
  const base = configHash(CONFIG);
  const mutated = JSON.parse(JSON.stringify(CONFIG));
  mutated.directionalChange.volMultiplier = 99;
  assert.notEqual(configHash(mutated), base);
});

test('config is frozen (published versions are immutable)', () => {
  assert.equal(Object.isFrozen(CONFIG), true);
});

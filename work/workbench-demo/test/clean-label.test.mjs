import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanLabel } from '../src/clean-label.mjs';

test('去除标签首尾空格', () => {
  assert.equal(cleanLabel('  demo  '), 'demo');
});

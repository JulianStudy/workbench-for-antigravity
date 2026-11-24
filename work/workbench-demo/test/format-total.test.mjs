import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatTotal } from '../src/format-total.mjs';

test('1250 分显示为 ¥12.50', () => {
  assert.equal(formatTotal(1250), '¥12.50');
});

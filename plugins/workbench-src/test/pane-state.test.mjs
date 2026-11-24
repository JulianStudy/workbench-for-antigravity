import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  clearErroredOutputCache,
  computeChecksRenderSignature,
  createExpandedOutputLoader,
} from '../src/ui/pane-state.mjs';

function makeSnapshot(overrides = {}) {
  return {
    ok: true,
    configOk: true,
    configError: null,
    rootError: null,
    isRunning: false,
    runningCheckId: null,
    runningBatch: false,
    timestamp: '2026-11-24T10:00:00.000Z',
    checks: [
      {
        id: 'format-total',
        name: '1250 分显示为 ¥12.50',
        commandDisplay: 'node --test test/format-total.test.mjs',
        timeoutMs: 15000,
        effectiveState: 'passed',
        isValid: true,
        isRunning: false,
        staleReason: null,
        changedFiles: [],
        checkError: null,
        lastRun: {
          status: 'passed',
          exitCode: 0,
          timedOut: false,
          finishedAt: '2026-11-24T09:59:00.000Z',
          durationMs: 42,
          hasOutput: true,
          outputTruncated: false,
        },
      },
      {
        id: 'clean-label',
        name: '去除标签首尾空格',
        commandDisplay: 'node --test test/clean-label.test.mjs',
        timeoutMs: 15000,
        effectiveState: 'passed',
        isValid: true,
        isRunning: false,
        staleReason: null,
        changedFiles: [],
        checkError: null,
        lastRun: {
          status: 'passed',
          exitCode: 0,
          timedOut: false,
          finishedAt: '2026-11-24T09:59:01.000Z',
          durationMs: 38,
          hasOutput: true,
          outputTruncated: false,
        },
      },
    ],
    ...overrides,
  };
}

test('computeChecksRenderSignature stays identical across unchanged polls (ignoring timestamp) and changes on UI/data updates', () => {
  const expandedCheckIds = new Set(['format-total']);
  const outputCache = new Map([
    [
      'format-total',
      {
        finishedAt: '2026-11-24T09:59:00.000Z',
        output: 'ok 1 - 1250 分显示为 ¥12.50',
        outputTruncated: false,
        loading: false,
        error: null,
      },
    ],
  ]);

  const snap1 = makeSnapshot({ timestamp: '2026-11-24T10:00:00.000Z' });
  const snap2 = makeSnapshot({ timestamp: '2026-11-24T10:00:02.000Z' });

  const sig1 = computeChecksRenderSignature({
    data: snap1,
    isConnected: true,
    busy: false,
    expandedCheckIds,
    outputCache,
  });
  const sig2 = computeChecksRenderSignature({
    data: snap2,
    isConnected: true,
    busy: false,
    expandedCheckIds,
    outputCache,
  });
  assert.equal(sig1, sig2, 'unchanged 2s poll must produce identical render signature');

  // Changing busy flag changes signature
  const sigBusy = computeChecksRenderSignature({
    data: snap2,
    isConnected: true,
    busy: true,
    expandedCheckIds,
    outputCache,
  });
  assert.notEqual(sig1, sigBusy);

  // Changing expanded set changes signature
  const sigExpanded = computeChecksRenderSignature({
    data: snap2,
    isConnected: true,
    busy: false,
    expandedCheckIds: new Set(['format-total', 'clean-label']),
    outputCache,
  });
  assert.notEqual(sig1, sigExpanded);

  // Changing cached output state changes signature
  const updatedCache = new Map(outputCache);
  updatedCache.set('format-total', {
    ...outputCache.get('format-total'),
    output: 'new output',
  });
  const sigOutputChanged = computeChecksRenderSignature({
    data: snap2,
    isConnected: true,
    busy: false,
    expandedCheckIds,
    outputCache: updatedCache,
  });
  assert.notEqual(sig1, sigOutputChanged);

  // Changing a check state changes signature
  const staleSnap = makeSnapshot();
  staleSnap.checks[0].effectiveState = 'stale';
  staleSnap.checks[0].changedFiles = ['src/format-total.mjs'];
  const sigStale = computeChecksRenderSignature({
    data: staleSnap,
    isConnected: true,
    busy: false,
    expandedCheckIds,
    outputCache,
  });
  assert.notEqual(sig1, sigStale);
});

test('createExpandedOutputLoader drains concurrent expand clicks sequentially without dropping check B', async () => {
  const snapshot = makeSnapshot();
  const expandedCheckIds = new Set();
  const outputCache = new Map();
  let renderCount = 0;

  let activeFetches = 0;
  let maxConcurrentFetches = 0;
  const fetchOrder = [];
  const resolvers = new Map();

  const loader = createExpandedOutputLoader({
    getChecks: () => snapshot.checks,
    expandedCheckIds,
    outputCache,
    canFetch: () => true,
    onStateChange: () => {
      renderCount += 1;
    },
    fetchDetail: (id) => {
      fetchOrder.push(id);
      activeFetches += 1;
      maxConcurrentFetches = Math.max(maxConcurrentFetches, activeFetches);
      return new Promise((resolve) => {
        resolvers.set(id, (payload) => {
          activeFetches -= 1;
          resolve(payload);
        });
      });
    },
  });

  // User clicks expand on check A, then immediately clicks expand on check B while A is in-flight
  loader.toggle('format-total');
  assert.equal(loader.isInFlight(), true);
  assert.deepEqual(fetchOrder, ['format-total']);

  loader.toggle('clean-label');
  // Still only 1 in-flight fetch (sequential)
  assert.equal(activeFetches, 1);
  assert.deepEqual(fetchOrder, ['format-total']);

  // Resolve check A -> loader MUST immediately drain check B without waiting for any poll
  resolvers.get('format-total')({
    ok: true,
    check: {
      id: 'format-total',
      lastRun: {
        finishedAt: '2026-11-24T09:59:00.000Z',
        output: 'output-A',
        outputTruncated: false,
      },
    },
  });

  // Allow microtasks to advance to check B fetch
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(fetchOrder, ['format-total', 'clean-label']);
  assert.equal(maxConcurrentFetches, 1);
  assert.equal(outputCache.get('format-total')?.output, 'output-A');

  resolvers.get('clean-label')({
    ok: true,
    check: {
      id: 'clean-label',
      lastRun: {
        finishedAt: '2026-11-24T09:59:01.000Z',
        output: 'output-B',
        outputTruncated: false,
      },
    },
  });

  await new Promise((r) => setImmediate(r));
  assert.equal(loader.isInFlight(), false);
  assert.equal(outputCache.get('clean-label')?.output, 'output-B');
  assert.equal(outputCache.get('clean-label')?.loading, false);
  assert.ok(renderCount >= 4);
});

test('createExpandedOutputLoader retries transient fetch errors upon collapse/re-expand or manual error clear without spamming background polls', async () => {
  const snapshot = makeSnapshot();
  const expandedCheckIds = new Set();
  const outputCache = new Map();
  let attempts = 0;

  const loader = createExpandedOutputLoader({
    getChecks: () => snapshot.checks,
    expandedCheckIds,
    outputCache,
    canFetch: () => true,
    onStateChange: () => {},
    fetchDetail: async (id) => {
      attempts += 1;
      if (attempts === 1) {
        throw new Error('temporary transport timeout');
      }
      if (attempts === 2) {
        return { ok: false, error: 'transient server busy' };
      }
      return {
        ok: true,
        check: {
          id,
          lastRun: {
            finishedAt: '2026-11-24T09:59:00.000Z',
            output: 'recovered-output',
            outputTruncated: false,
          },
        },
      };
    },
  });

  // 1st expand fails with thrown error
  loader.toggle('format-total');
  await new Promise((r) => setImmediate(r));
  assert.equal(attempts, 1);
  assert.match(outputCache.get('format-total')?.error || '', /temporary transport timeout/);

  // Repeated background poll drain() while still expanded does NOT spam retries
  await loader.drain();
  assert.equal(attempts, 1);

  // Collapse + re-expand MUST clear error cache and retry immediately
  loader.toggle('format-total'); // collapse
  assert.equal(outputCache.has('format-total'), false);

  loader.toggle('format-total'); // re-expand -> attempt 2 (returns ok: false error)
  await new Promise((r) => setImmediate(r));
  assert.equal(attempts, 2);
  assert.match(outputCache.get('format-total')?.error || '', /transient server busy/);

  // Manual refresh clearing errored cache entries also allows retry while expanded
  clearErroredOutputCache(outputCache);
  await loader.drain();
  assert.equal(attempts, 3);
  assert.equal(outputCache.get('format-total')?.error, null);
  assert.equal(outputCache.get('format-total')?.output, 'recovered-output');
});

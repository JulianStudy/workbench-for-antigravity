import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  MAX_FAILURE_EVIDENCE_BYTES,
  attachFailureEvidenceContext,
  buildFailureEvidencePreview,
  canAttachFailureEvidence,
  clearErroredOutputCache,
  computeChecksRenderSignature,
  createExpandedOutputLoader,
  redactWorkspacePaths,
  shouldShowReplaceEvidenceWarning,
  truncateUtf8TextToBudget,
  utf8ByteLength,
} from '../src/ui/pane-state.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

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

test('canAttachFailureEvidence allows ONLY valid non-running failed checks with lastRun', () => {
  const baseLastRun = {
    status: 'failed',
    exitCode: 1,
    finishedAt: '2026-11-25T07:00:00.000Z',
  };

  assert.equal(
    canAttachFailureEvidence({
      id: 'c1',
      effectiveState: 'failed',
      isValid: true,
      isRunning: false,
      lastRun: baseLastRun,
    }),
    true
  );

  // Stale even when lastRun.status === 'failed'
  assert.equal(
    canAttachFailureEvidence({
      id: 'c1',
      effectiveState: 'stale',
      isValid: false,
      isRunning: false,
      lastRun: baseLastRun,
    }),
    false
  );

  // Passed
  assert.equal(
    canAttachFailureEvidence({
      id: 'c1',
      effectiveState: 'passed',
      isValid: true,
      isRunning: false,
      lastRun: { ...baseLastRun, status: 'passed', exitCode: 0 },
    }),
    false
  );

  // Not run
  assert.equal(
    canAttachFailureEvidence({
      id: 'c1',
      effectiveState: 'not_run',
      isValid: false,
      isRunning: false,
      lastRun: null,
    }),
    false
  );

  // Error
  assert.equal(
    canAttachFailureEvidence({
      id: 'c1',
      effectiveState: 'error',
      isValid: false,
      isRunning: false,
      lastRun: { ...baseLastRun, status: 'error', exitCode: null },
    }),
    false
  );

  // Running check
  assert.equal(
    canAttachFailureEvidence({
      id: 'c1',
      effectiveState: 'failed',
      isValid: true,
      isRunning: true,
      lastRun: baseLastRun,
    }),
    false
  );

  // Missing lastRun or invalid
  assert.equal(
    canAttachFailureEvidence({
      id: 'c1',
      effectiveState: 'failed',
      isValid: true,
      isRunning: false,
      lastRun: null,
    }),
    false
  );
  assert.equal(
    canAttachFailureEvidence({
      id: 'c1',
      effectiveState: 'failed',
      isValid: false,
      isRunning: false,
      lastRun: baseLastRun,
    }),
    false
  );
  assert.equal(canAttachFailureEvidence(null), false);
});

test('redactWorkspacePaths replaces absolute and file:// workspace paths without corrupting sibling paths', () => {
  const root = '/Users/julian/work/my-demo';
  const raw = [
    'at TestContext.<anonymous> (file:///Users/julian/work/my-demo/test/format-total.test.mjs:14:10)',
    'file:///Users/julian/work/my-demo',
    'Error in /Users/julian/work/my-demo/src/format-total.mjs:5:3',
    'cwd=/Users/julian/work/my-demo',
    'sibling1=/Users/julian/work/my-demo-other/src/a.mjs',
    'sibling2=file:///Users/julian/work/my-demo-other/src/b.mjs',
    'sibling3=/Users/julian/work/my-demo_copy/index.js',
    'sibling4=/Users/julian/work/my-demo.bak/index.js',
  ].join('\n');

  const redacted = redactWorkspacePaths(raw, root);
  assert.equal(
    redacted,
    [
      'at TestContext.<anonymous> (test/format-total.test.mjs:14:10)',
      '.',
      'Error in src/format-total.mjs:5:3',
      'cwd=.',
      'sibling1=/Users/julian/work/my-demo-other/src/a.mjs',
      'sibling2=file:///Users/julian/work/my-demo-other/src/b.mjs',
      'sibling3=/Users/julian/work/my-demo_copy/index.js',
      'sibling4=/Users/julian/work/my-demo.bak/index.js',
    ].join('\n')
  );

  // Handles trailing slash in projectRoot and URL-encoded spaces/CJK characters
  const encodedRoot = '/Users/julian/my space/测试项目/';
  const encodedInput = [
    'at file:///Users/julian/my%20space/%E6%B5%8B%E8%AF%95%E9%A1%B9%E7%9B%AE/src/app.mjs:8:2',
    'rootUrl=file:///Users/julian/my%20space/%E6%B5%8B%E8%AF%95%E9%A1%B9%E7%9B%AE',
    'rawPath=/Users/julian/my space/测试项目/test/a.test.mjs',
    'bareRoot=/Users/julian/my space/测试项目',
  ].join('\n');

  const redactedEncoded = redactWorkspacePaths(encodedInput, encodedRoot);
  assert.equal(
    redactedEncoded,
    [
      'at src/app.mjs:8:2',
      'rootUrl=.',
      'rawPath=test/a.test.mjs',
      'bareRoot=.',
    ].join('\n')
  );
  assert.equal(redactedEncoded.includes('/Users/julian/my space/测试项目'), false);
  assert.equal(redactedEncoded.includes('my%20space'), false);

  // Handles Windows path separators cleanly
  const winRoot = 'C:\\Users\\dev\\demo';
  const winInput = 'at C:\\Users\\dev\\demo\\src\\index.mjs:1:1\nfile:///C:/Users/dev/demo/test/a.mjs:2:1\ncwd=C:\\Users\\dev\\demo';
  const redactedWin = redactWorkspacePaths(winInput, winRoot);
  assert.equal(redactedWin, 'at src\\index.mjs:1:1\ntest/a.mjs:2:1\ncwd=.');
});

test('truncateUtf8TextToBudget enforces strict UTF-8 byte budget without splitting multibyte or surrogate pairs', () => {
  const shortText = 'hello 世界';
  const shortRes = truncateUtf8TextToBudget(shortText, 64, '\n...[truncated]');
  assert.equal(shortRes.truncated, false);
  assert.equal(shortRes.text, shortText);
  assert.equal(shortRes.byteLength, utf8ByteLength(shortText));

  // Build text containing 3-byte CJK and 4-byte emoji surrogate pairs
  const unit = '失败🔥测试🧪';
  const huge = unit.repeat(300);
  const suffix = '\n...[失败摘要已截断，上限 2 KiB]';
  const res = truncateUtf8TextToBudget(huge, MAX_FAILURE_EVIDENCE_BYTES, suffix);

  assert.equal(res.truncated, true);
  assert.ok(res.text.endsWith(suffix));
  const actualBytes = new TextEncoder().encode(res.text).length;
  assert.equal(res.byteLength, actualBytes);
  assert.ok(actualBytes <= MAX_FAILURE_EVIDENCE_BYTES, `expected ${actualBytes} <= 2048`);
  assert.equal(res.text.includes('\uFFFD'), false, 'must not contain replacement character');
  // Verify no lone UTF-16 surrogates remain
  assert.equal(
    /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(res.text),
    false,
    'must never split a UTF-16 surrogate pair'
  );

  // Tight boundary: exact byte sizes around emoji/CJK boundaries
  for (let budget = 20; budget <= 45; budget += 1) {
    const r = truncateUtf8TextToBudget('a测试🔥b🧪中', budget, '…');
    assert.ok(new TextEncoder().encode(r.text).length <= budget);
    assert.equal(
      /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(r.text),
      false
    );
  }
});

test('buildFailureEvidencePreview formats clean redacted evidence strictly within 2 KiB UTF-8 budget', () => {
  const projectRoot = '/Users/julian/workspaces/secret-demo';
  const check = {
    id: 'format-total',
    name: '1250 分显示为 ¥12.50',
    effectiveState: 'failed',
    isValid: true,
    isRunning: false,
    lastRun: {
      status: 'failed',
      exitCode: 1,
      finishedAt: '2026-11-25T07:10:00.000Z',
    },
  };

  const output = [
    'not ok 1 - 1250 分显示为 ¥12.50',
    `  at file://${projectRoot}/test/format-total.test.mjs:12:5`,
    `  source: ${projectRoot}/src/format-total.mjs`,
    "  expected: '¥12.50', actual: '¥12.5'",
    '   ',
    '',
  ].join('\n');

  const preview = buildFailureEvidencePreview({ check, output, projectRoot });
  assert.equal(preview.truncated, false);
  assert.equal(preview.byteLength, new TextEncoder().encode(preview.text).length);
  assert.ok(preview.byteLength <= MAX_FAILURE_EVIDENCE_BYTES);
  assert.equal(preview.text.includes(projectRoot), false, 'must not leak projectRoot');
  assert.equal(
    preview.text,
    [
      '[Workbench 失败证据]',
      '检查项: 1250 分显示为 ¥12.50 (format-total)',
      '退出码: 1',
      '检查时间: 2026-11-25T07:10:00.000Z',
      '失败摘要:',
      'not ok 1 - 1250 分显示为 ¥12.50',
      '  at test/format-total.test.mjs:12:5',
      '  source: src/format-total.mjs',
      "  expected: '¥12.50', actual: '¥12.5'",
    ].join('\n')
  );

  // Empty output -> (无输出)
  const emptyPreview = buildFailureEvidencePreview({ check, output: '   \n\n', projectRoot });
  assert.ok(emptyPreview.text.endsWith('失败摘要:\n(无输出)'));

  // Oversized output -> truncated strictly within 2048 UTF-8 bytes including notice
  const longOutput = `AssertionError at file://${projectRoot}/test/format-total.test.mjs:12:5\n` + '详细失败日志🔥中文输出\n'.repeat(300);
  const truncatedPreview = buildFailureEvidencePreview({ check, output: longOutput, projectRoot });
  assert.equal(truncatedPreview.truncated, true);
  assert.ok(truncatedPreview.byteLength <= MAX_FAILURE_EVIDENCE_BYTES);
  assert.equal(truncatedPreview.byteLength, new TextEncoder().encode(truncatedPreview.text).length);
  assert.equal(truncatedPreview.text.includes(projectRoot), false);
  assert.match(truncatedPreview.text, /\[失败摘要已截断，上限 2 KiB\]$/);
});

test('attachFailureEvidenceContext enforces host capabilities, calls updateModelContext once on click, never calls sendMessage, and handles rejection', async () => {
  const check = {
    id: 'format-total',
    name: '1250 分显示为 ¥12.50',
    effectiveState: 'failed',
    isValid: true,
    isRunning: false,
    lastRun: {
      status: 'failed',
      exitCode: 1,
      finishedAt: '2026-11-25T07:10:00.000Z',
    },
  };
  const projectRoot = '/tmp/wb-demo';
  const output = `AssertionError in ${projectRoot}/src/format-total.mjs:3`;

  // 1. Missing host capability -> no updateModelContext call, clear fallback message, preview preserved
  let updateCalls = 0;
  let sendMessageCalls = 0;
  const unsupportedRes = await attachFailureEvidenceContext({
    app: {
      getHostCapabilities: () => ({}),
      updateModelContext: async () => {
        updateCalls += 1;
      },
      sendMessage: async () => {
        sendMessageCalls += 1;
      },
    },
    check,
    output,
    projectRoot,
  });
  assert.equal(unsupportedRes.ok, false);
  assert.equal(unsupportedRes.reason, 'unsupported');
  assert.equal(updateCalls, 0);
  assert.equal(sendMessageCalls, 0);
  assert.match(unsupportedRes.message, /当前宿主不支持附加模型上下文/);
  assert.ok(unsupportedRes.preview?.text.includes('[Workbench 失败证据]'));

  // 2. Supported host -> calls updateModelContext({ content: [{ type: 'text', text }] }), never sendMessage
  const receivedPayloads = [];
  const supportedRes = await attachFailureEvidenceContext({
    app: {
      getHostCapabilities: () => ({ updateModelContext: {} }),
      updateModelContext: async (params) => {
        receivedPayloads.push(params);
        return {};
      },
      sendMessage: async () => {
        sendMessageCalls += 1;
      },
    },
    check,
    output,
    projectRoot,
  });
  assert.equal(supportedRes.ok, true);
  assert.equal(sendMessageCalls, 0);
  assert.equal(receivedPayloads.length, 1);
  assert.deepEqual(receivedPayloads[0], {
    content: [{ type: 'text', text: supportedRes.preview.text }],
  });
  assert.equal(supportedRes.attached.id, 'format-total');
  assert.equal(supportedRes.attached.name, '1250 分显示为 ¥12.50');
  assert.equal(supportedRes.attached.finishedAt, '2026-11-25T07:10:00.000Z');
  assert.match(supportedRes.message, /已附加失败证据/);

  // 3. Rejection -> returns explicit error message while keeping preview
  const rejectedRes = await attachFailureEvidenceContext({
    app: {
      getHostCapabilities: () => ({ updateModelContext: {} }),
      updateModelContext: async () => {
        throw new Error('host context denied');
      },
      sendMessage: async () => {
        sendMessageCalls += 1;
      },
    },
    check,
    output,
    projectRoot,
  });
  assert.equal(rejectedRes.ok, false);
  assert.equal(rejectedRes.reason, 'error');
  assert.equal(sendMessageCalls, 0);
  assert.match(rejectedRes.message, /附加失败（host context denied）/);
  assert.ok(rejectedRes.preview?.text.includes('src/format-total.mjs:3'));

  // 4. Stale check -> blocked before calling updateModelContext
  const staleRes = await attachFailureEvidenceContext({
    app: {
      getHostCapabilities: () => ({ updateModelContext: {} }),
      updateModelContext: async () => {
        updateCalls += 1;
      },
    },
    check: { ...check, effectiveState: 'stale', isValid: false },
    output,
    projectRoot,
  });
  assert.equal(staleRes.ok, false);
  assert.equal(staleRes.reason, 'ineligible');
  assert.equal(updateCalls, 0);
});

test('computeChecksRenderSignature covers preview/attach state while staying stable across unchanged 2s polls', () => {
  const expandedCheckIds = new Set();
  const previewCheckIds = new Set(['format-total']);
  const outputCache = new Map([
    [
      'format-total',
      {
        finishedAt: '2026-11-24T09:59:00.000Z',
        output: 'AssertionError: failed',
        outputTruncated: false,
        loading: false,
        error: null,
      },
    ],
  ]);
  const attachFeedbackByCheckId = new Map([
    ['format-total', { type: 'error', message: '当前宿主不支持附加模型上下文，请直接选中上方预览文本复制使用。' }],
  ]);
  const lastAttachedEvidence = {
    id: 'clean-label',
    name: '去除标签首尾空格',
    finishedAt: '2026-11-24T09:59:01.000Z',
    attachedAt: '2026-11-24T10:00:00.000Z',
  };

  const snap1 = makeSnapshot({ projectRoot: '/tmp/demo', timestamp: '2026-11-24T10:00:00.000Z' });
  const snap2 = makeSnapshot({ projectRoot: '/tmp/demo', timestamp: '2026-11-24T10:00:02.000Z' });
  snap1.checks[0].effectiveState = 'failed';
  snap2.checks[0].effectiveState = 'failed';

  const baseArgs = {
    data: snap1,
    isConnected: true,
    busy: false,
    expandedCheckIds,
    previewCheckIds,
    outputCache,
    attachInFlight: false,
    attachInFlightCheckId: null,
    attachFeedbackByCheckId,
    lastAttachedEvidence,
  };

  const sig1 = computeChecksRenderSignature(baseArgs);
  const sig2 = computeChecksRenderSignature({ ...baseArgs, data: snap2 });
  assert.equal(sig1, sig2, 'unchanged poll with open preview must not change render signature');

  // Closing preview changes signature
  assert.notEqual(
    sig1,
    computeChecksRenderSignature({ ...baseArgs, previewCheckIds: new Set() })
  );

  // Output arriving while preview is open (even when expandedCheckIds is empty!) changes signature
  const updatedCache = new Map(outputCache);
  updatedCache.set('format-total', { ...outputCache.get('format-total'), output: 'updated error output' });
  assert.notEqual(
    sig1,
    computeChecksRenderSignature({ ...baseArgs, outputCache: updatedCache })
  );

  // attachInFlight changes signature
  assert.notEqual(
    sig1,
    computeChecksRenderSignature({ ...baseArgs, attachInFlight: true, attachInFlightCheckId: 'format-total' })
  );

  // attachFeedback changes signature
  const updatedFeedback = new Map([['format-total', { type: 'success', message: '已附加' }]]);
  assert.notEqual(
    sig1,
    computeChecksRenderSignature({ ...baseArgs, attachFeedbackByCheckId: updatedFeedback })
  );

  // lastAttachedEvidence changes signature
  assert.notEqual(
    sig1,
    computeChecksRenderSignature({
      ...baseArgs,
      lastAttachedEvidence: { ...lastAttachedEvidence, id: 'format-total' },
    })
  );
});

test('createExpandedOutputLoader fetches output on demand when previewCheckIds includes a check', async () => {
  const snapshot = makeSnapshot();
  snapshot.checks[0].effectiveState = 'failed';
  const expandedCheckIds = new Set();
  const previewCheckIds = new Set(['format-total']);
  const outputCache = new Map();
  const fetched = [];

  const loader = createExpandedOutputLoader({
    getChecks: () => snapshot.checks,
    expandedCheckIds,
    previewCheckIds,
    outputCache,
    canFetch: () => true,
    onStateChange: () => {},
    fetchDetail: async (id) => {
      fetched.push(id);
      return {
        ok: true,
        check: {
          id,
          lastRun: {
            finishedAt: '2026-11-24T09:59:00.000Z',
            output: 'preview failure detail output',
            outputTruncated: false,
          },
        },
      };
    },
  });

  await loader.drain();
  assert.deepEqual(fetched, ['format-total']);
  assert.equal(outputCache.get('format-total')?.output, 'preview failure detail output');
  assert.equal(outputCache.get('format-total')?.loading, false);
});

test('shouldShowReplaceEvidenceWarning suppresses warning only when the exact check run just succeeded attaching', () => {
  const check = {
    id: 'format-total',
    name: '1250 分显示为 ¥12.50',
    lastRun: {
      finishedAt: '2026-11-24T09:59:00.000Z',
    },
  };
  const attachedSameRun = {
    id: 'format-total',
    name: '1250 分显示为 ¥12.50',
    finishedAt: '2026-11-24T09:59:00.000Z',
    attachedAt: '2026-11-24T10:00:00.000Z',
  };
  const successFeedback = {
    type: 'success',
    message: '已附加失败证据',
    finishedAt: '2026-11-24T09:59:00.000Z',
  };

  // No previously attached evidence -> never show replace warning
  assert.equal(
    shouldShowReplaceEvidenceWarning({
      check,
      lastAttachedEvidence: null,
      feedback: null,
    }),
    false
  );

  // Immediately after attaching this exact check run (green confirmation visible) -> suppress replace warning
  assert.equal(
    shouldShowReplaceEvidenceWarning({
      check,
      lastAttachedEvidence: attachedSameRun,
      feedback: successFeedback,
    }),
    false
  );

  // Previewing a different check while another check is attached -> show replace warning
  assert.equal(
    shouldShowReplaceEvidenceWarning({
      check: {
        id: 'clean-label',
        name: '去除标签首尾空格',
        lastRun: { finishedAt: '2026-11-24T09:59:01.000Z' },
      },
      lastAttachedEvidence: attachedSameRun,
      feedback: null,
    }),
    true
  );

  // Previewing a newer failed run of the same check -> show replace warning
  assert.equal(
    shouldShowReplaceEvidenceWarning({
      check: {
        ...check,
        lastRun: { finishedAt: '2026-11-24T10:05:00.000Z' },
      },
      lastAttachedEvidence: attachedSameRun,
      feedback: successFeedback,
    }),
    true
  );

  // Re-opening preview after closing it (feedback cleared) -> show replace warning
  assert.equal(
    shouldShowReplaceEvidenceWarning({
      check,
      lastAttachedEvidence: attachedSameRun,
      feedback: null,
    }),
    true
  );

  // Non-success feedback (e.g. retry error on the same check) -> show replace warning
  assert.equal(
    shouldShowReplaceEvidenceWarning({
      check,
      lastAttachedEvidence: attachedSameRun,
      feedback: { type: 'error', message: '附加失败' },
    }),
    true
  );
});

test('UI modules stay browser-compatible (no Buffer or node:* imports) and never call sendMessage', () => {
  const stripComments = (code) =>
    code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
  const paneStateSrc = stripComments(
    fs.readFileSync(path.join(__dirname, '../src/ui/pane-state.mjs'), 'utf8')
  );
  const paneJsSrc = stripComments(
    fs.readFileSync(path.join(__dirname, '../src/ui/pane.js'), 'utf8')
  );

  for (const [label, src] of [
    ['pane-state.mjs', paneStateSrc],
    ['pane.js', paneJsSrc],
  ]) {
    assert.doesNotMatch(src, /\bfrom\s+['"]node:/, `${label} must not import node:* modules`);
    assert.doesNotMatch(src, /\bBuffer\b/, `${label} must not use Node Buffer`);
    assert.doesNotMatch(src, /\bsendMessage\b/, `${label} must never call app.sendMessage()`);
  }
});

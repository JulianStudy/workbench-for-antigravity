/**
 * Pure UI state and failure-evidence helpers for Workbench sidebar rendering.
 * Kept DOM-free and browser+Node compatible (no Node Buffer or node:* imports)
 * so esbuild bundles it into pane.html while node:test can verify it directly.
 */

export const MAX_FAILURE_EVIDENCE_BYTES = 2048;
export const DEFAULT_FAILURE_EVIDENCE_TRUNCATION_SUFFIX = '\n...[失败摘要已截断，上限 2 KiB]';

const textEncoder = new TextEncoder();

export function utf8ByteLength(text) {
  return textEncoder.encode(String(text ?? '')).length;
}

function escapeRegExp(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function encodePathForFileUrl(posixPath) {
  return posixPath
    .split('/')
    .map((seg, idx) => (idx === 0 && /^[A-Za-z]:$/.test(seg) ? seg : encodeURIComponent(seg)))
    .join('/');
}

function sliceCodePointsToMaxBytes(input, maxBytes) {
  if (maxBytes <= 0 || !input) {
    return { text: '', byteLength: 0 };
  }
  let used = 0;
  const parts = [];
  for (const cp of input) {
    const cpBytes = textEncoder.encode(cp).length;
    if (used + cpBytes > maxBytes) {
      break;
    }
    parts.push(cp);
    used += cpBytes;
  }
  return { text: parts.join(''), byteLength: used };
}

export function canAttachFailureEvidence(check) {
  return Boolean(
    check &&
      !check.isRunning &&
      check.effectiveState === 'failed' &&
      check.isValid === true &&
      check.lastRun
  );
}

export function redactWorkspacePaths(text, projectRoot) {
  let result = String(text ?? '');
  if (!result || !projectRoot || typeof projectRoot !== 'string') {
    return result;
  }

  const trimmed = projectRoot.replace(/[\\/]+$/, '');
  if (!trimmed) {
    return result;
  }

  const posixRoot = trimmed.replace(/\\/g, '/');
  const fileUrlBase = posixRoot.startsWith('/') ? `file://${posixRoot}` : `file:///${posixRoot}`;
  const encodedPosixRoot = encodePathForFileUrl(posixRoot);
  const encodedFileUrlBase = encodedPosixRoot.startsWith('/')
    ? `file://${encodedPosixRoot}`
    : `file:///${encodedPosixRoot}`;
  const uriPosixRoot = encodeURI(posixRoot);
  const uriFileUrlBase = uriPosixRoot.startsWith('/')
    ? `file://${uriPosixRoot}`
    : `file:///${uriPosixRoot}`;

  const fileUrlVariants = Array.from(
    new Set([encodedFileUrlBase, uriFileUrlBase, fileUrlBase])
  ).sort((a, b) => b.length - a.length);

  for (const urlRoot of fileUrlVariants) {
    const escaped = escapeRegExp(urlRoot);
    result = result.replace(new RegExp(`${escaped}/+`, 'g'), '');
    result = result.replace(new RegExp(`${escaped}(?![\\p{L}\\p{N}._\\-/\\\\~%])`, 'gu'), '.');
  }

  const rawVariants = Array.from(new Set([trimmed, posixRoot])).sort((a, b) => b.length - a.length);
  for (const rawRoot of rawVariants) {
    const escaped = escapeRegExp(rawRoot);
    result = result.replace(
      new RegExp(`(?<![\\p{L}\\p{N}._\\-/\\\\])${escaped}[\\\\/]+`, 'gu'),
      ''
    );
    result = result.replace(
      new RegExp(`(?<![\\p{L}\\p{N}._\\-/\\\\])${escaped}(?![\\p{L}\\p{N}._\\-/\\\\~%])`, 'gu'),
      '.'
    );
  }

  return result;
}

export function truncateUtf8TextToBudget(
  text,
  maxBytes = MAX_FAILURE_EVIDENCE_BYTES,
  suffix = DEFAULT_FAILURE_EVIDENCE_TRUNCATION_SUFFIX
) {
  const str = String(text ?? '');
  const totalBytes = utf8ByteLength(str);
  if (maxBytes <= 0) {
    return { text: '', truncated: totalBytes > 0, byteLength: 0 };
  }
  if (totalBytes <= maxBytes) {
    return { text: str, truncated: false, byteLength: totalBytes };
  }

  const safeSuffix = String(suffix ?? '');
  const suffixBytes = utf8ByteLength(safeSuffix);
  if (suffixBytes > maxBytes) {
    const clippedSuffix = sliceCodePointsToMaxBytes(safeSuffix, maxBytes);
    return {
      text: clippedSuffix.text,
      truncated: true,
      byteLength: utf8ByteLength(clippedSuffix.text),
    };
  }

  const prefixBudget = maxBytes - suffixBytes;
  const prefix = sliceCodePointsToMaxBytes(str, prefixBudget);
  const finalText = `${prefix.text}${safeSuffix}`;
  return {
    text: finalText,
    truncated: true,
    byteLength: utf8ByteLength(finalText),
  };
}

export function buildFailureEvidencePreview({
  check,
  output,
  projectRoot = '',
  maxBytes = MAX_FAILURE_EVIDENCE_BYTES,
}) {
  const safeName = redactWorkspacePaths(String(check?.name ?? ''), projectRoot);
  const checkId = String(check?.id ?? '-');
  const exitCode =
    check?.lastRun?.exitCode === null || check?.lastRun?.exitCode === undefined
      ? '-'
      : String(check.lastRun.exitCode);
  const finishedAt = check?.lastRun?.finishedAt || '-';

  const redactedOutput = redactWorkspacePaths(String(output ?? ''), projectRoot).replace(
    /\r\n/g,
    '\n'
  );
  const cleanedOutput =
    redactedOutput.trim().length === 0
      ? '(无输出)'
      : redactedOutput.replace(/^\n+/, '').trimEnd();

  const fullText = [
    '[Workbench 失败证据]',
    `检查项: ${safeName} (${checkId})`,
    `退出码: ${exitCode}`,
    `检查时间: ${finishedAt}`,
    '失败摘要:',
    cleanedOutput,
  ].join('\n');

  return truncateUtf8TextToBudget(
    fullText,
    maxBytes,
    DEFAULT_FAILURE_EVIDENCE_TRUNCATION_SUFFIX
  );
}

export async function attachFailureEvidenceContext({
  app,
  check,
  output,
  projectRoot = '',
  maxBytes = MAX_FAILURE_EVIDENCE_BYTES,
}) {
  if (!canAttachFailureEvidence(check)) {
    return {
      ok: false,
      reason: 'ineligible',
      preview: null,
      attached: null,
      message: '当前检查项不是有效的失败状态，无法附加失败证据。',
    };
  }

  const preview = buildFailureEvidencePreview({ check, output, projectRoot, maxBytes });
  const capabilities =
    typeof app?.getHostCapabilities === 'function' ? app.getHostCapabilities() : null;

  if (!capabilities?.updateModelContext || typeof app?.updateModelContext !== 'function') {
    return {
      ok: false,
      reason: 'unsupported',
      preview,
      attached: null,
      message: '当前宿主不支持附加模型上下文，请直接选中上方预览文本复制使用。',
    };
  }

  try {
    await app.updateModelContext({
      content: [{ type: 'text', text: preview.text }],
    });
    const attached = {
      id: check.id,
      name: check.name,
      finishedAt: check.lastRun.finishedAt,
      attachedAt: new Date().toISOString(),
    };
    return {
      ok: true,
      reason: null,
      preview,
      attached,
      message: `已附加失败证据（${check.name} / ${check.id}），请手动发送下一条消息让 Agent 使用该证据。再次附加将替换本次证据。`,
    };
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      reason: 'error',
      preview,
      attached: null,
      message: `附加失败（${errMsg}），请直接选中上方预览文本复制使用。`,
    };
  }
}

export function computeChecksRenderSignature({
  data,
  isConnected,
  busy,
  expandedCheckIds,
  previewCheckIds = new Set(),
  outputCache,
  attachInFlight = false,
  attachInFlightCheckId = null,
  attachFeedbackByCheckId = new Map(),
  lastAttachedEvidence = null,
}) {
  if (!data) {
    return JSON.stringify({ empty: true, isConnected: Boolean(isConnected), busy: Boolean(busy) });
  }

  const checks = Array.isArray(data.checks)
    ? data.checks.map((check) => {
        const isExpanded = expandedCheckIds.has(check.id);
        const isPreviewOpen = previewCheckIds.has(check.id);
        const cached = isExpanded || isPreviewOpen ? outputCache.get(check.id) || null : null;
        const feedback = isPreviewOpen ? attachFeedbackByCheckId.get(check.id) || null : null;
        return {
          id: check.id,
          name: check.name,
          commandDisplay: check.commandDisplay || (check.command || []).join(' '),
          timeoutMs: check.timeoutMs,
          effectiveState: check.effectiveState,
          isValid: Boolean(check.isValid),
          isRunning: Boolean(check.isRunning),
          staleReason: check.staleReason || null,
          changedFiles: Array.isArray(check.changedFiles) ? check.changedFiles : [],
          checkError: check.checkError || null,
          lastRun: check.lastRun
            ? {
                status: check.lastRun.status,
                exitCode: check.lastRun.exitCode ?? null,
                timedOut: Boolean(check.lastRun.timedOut),
                finishedAt: check.lastRun.finishedAt || null,
                durationMs: check.lastRun.durationMs ?? null,
                hasOutput: Boolean(check.lastRun.hasOutput),
                outputTruncated: Boolean(check.lastRun.outputTruncated),
              }
            : null,
          expanded: isExpanded,
          previewOpen: isPreviewOpen,
          attachFeedback: feedback
            ? {
                type: feedback.type || 'info',
                message: feedback.message || '',
              }
            : null,
          cachedOutput: cached
            ? {
                finishedAt: cached.finishedAt || null,
                output: cached.output || '',
                outputTruncated: Boolean(cached.outputTruncated),
                loading: Boolean(cached.loading),
                error: cached.error || null,
              }
            : null,
        };
      })
    : [];

  return JSON.stringify({
    ok: data.ok !== false,
    configOk: data.configOk !== false,
    projectRoot: data.projectRoot || null,
    rootError: data.rootError || null,
    configError: data.configError || null,
    isConnected: Boolean(isConnected),
    busy: Boolean(busy),
    attachInFlight: Boolean(attachInFlight),
    attachInFlightCheckId: attachInFlightCheckId || null,
    lastAttachedEvidence: lastAttachedEvidence
      ? {
          id: lastAttachedEvidence.id,
          name: lastAttachedEvidence.name,
          finishedAt: lastAttachedEvidence.finishedAt || null,
          attachedAt: lastAttachedEvidence.attachedAt || null,
        }
      : null,
    checks,
  });
}

export function clearErroredOutputCache(outputCache) {
  let cleared = false;
  for (const [id, entry] of outputCache.entries()) {
    if (entry && entry.error) {
      outputCache.delete(id);
      cleared = true;
    }
  }
  return cleared;
}

export function createExpandedOutputLoader({
  getChecks,
  expandedCheckIds,
  previewCheckIds = new Set(),
  outputCache,
  fetchDetail,
  onStateChange,
  canFetch = () => true,
}) {
  let inFlight = false;
  let rerunRequested = false;

  function isCheckNeeded(id) {
    return expandedCheckIds.has(id) || previewCheckIds.has(id);
  }

  function findNextPendingCheck() {
    const checks = getChecks();
    if (!Array.isArray(checks)) return null;
    const neededIds = new Set([...expandedCheckIds, ...previewCheckIds]);
    for (const id of neededIds) {
      const check = checks.find((c) => c.id === id);
      if (!check || !check.lastRun) continue;
      const cached = outputCache.get(id);
      if (!cached || (cached.finishedAt !== check.lastRun.finishedAt && !cached.loading)) {
        return check;
      }
    }
    return null;
  }

  async function drain() {
    if (!canFetch()) return;
    if (inFlight) {
      rerunRequested = true;
      return;
    }

    inFlight = true;
    try {
      while (canFetch()) {
        rerunRequested = false;
        const nextCheck = findNextPendingCheck();
        if (!nextCheck) {
          if (rerunRequested) continue;
          break;
        }

        const checkId = nextCheck.id;
        const targetFinishedAt = nextCheck.lastRun.finishedAt;

        outputCache.set(checkId, {
          finishedAt: targetFinishedAt,
          output: outputCache.get(checkId)?.output || '',
          outputTruncated: Boolean(nextCheck.lastRun.outputTruncated),
          loading: true,
          error: null,
        });
        onStateChange();

        try {
          const detail = await fetchDetail(checkId);
          if (detail?.ok && detail.check?.lastRun) {
            outputCache.set(checkId, {
              finishedAt: detail.check.lastRun.finishedAt,
              output: detail.check.lastRun.output || '',
              outputTruncated: Boolean(detail.check.lastRun.outputTruncated),
              loading: false,
              error: null,
            });
          } else if (!isCheckNeeded(checkId)) {
            outputCache.delete(checkId);
          } else {
            outputCache.set(checkId, {
              finishedAt: targetFinishedAt,
              output: '',
              outputTruncated: false,
              loading: false,
              error: detail?.error || '未能获取检查输出',
            });
          }
        } catch (err) {
          if (!isCheckNeeded(checkId)) {
            outputCache.delete(checkId);
          } else {
            outputCache.set(checkId, {
              finishedAt: targetFinishedAt,
              output: '',
              outputTruncated: false,
              loading: false,
              error: err instanceof Error ? err.message : String(err),
            });
          }
        }

        onStateChange();
      }
    } finally {
      inFlight = false;
    }
  }

  function toggle(id) {
    if (expandedCheckIds.has(id)) {
      expandedCheckIds.delete(id);
      if (!isCheckNeeded(id) && outputCache.get(id)?.error) {
        outputCache.delete(id);
      }
      onStateChange();
      return false;
    }
    if (outputCache.get(id)?.error) {
      outputCache.delete(id);
    }
    expandedCheckIds.add(id);
    onStateChange();
    void drain();
    return true;
  }

  function openPreview(id) {
    if (outputCache.get(id)?.error) {
      outputCache.delete(id);
    }
    previewCheckIds.add(id);
    onStateChange();
    void drain();
  }

  function closePreview(id) {
    previewCheckIds.delete(id);
    if (!isCheckNeeded(id) && outputCache.get(id)?.error) {
      outputCache.delete(id);
    }
    onStateChange();
  }

  function togglePreview(id) {
    if (previewCheckIds.has(id)) {
      closePreview(id);
      return false;
    }
    openPreview(id);
    return true;
  }

  return {
    drain,
    toggle,
    openPreview,
    closePreview,
    togglePreview,
    isInFlight: () => inFlight,
  };
}

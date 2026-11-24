/**
 * Pure UI state helpers for Workbench sidebar rendering and lazy output loading.
 * Kept DOM-free so esbuild bundles it into pane.html while node:test can verify it directly.
 */

export function computeChecksRenderSignature({
  data,
  isConnected,
  busy,
  expandedCheckIds,
  outputCache,
}) {
  if (!data) {
    return JSON.stringify({ empty: true, isConnected: Boolean(isConnected), busy: Boolean(busy) });
  }

  const checks = Array.isArray(data.checks)
    ? data.checks.map((check) => {
        const isExpanded = expandedCheckIds.has(check.id);
        const cached = isExpanded ? outputCache.get(check.id) || null : null;
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
    rootError: data.rootError || null,
    configError: data.configError || null,
    isConnected: Boolean(isConnected),
    busy: Boolean(busy),
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
  outputCache,
  fetchDetail,
  onStateChange,
  canFetch = () => true,
}) {
  let inFlight = false;
  let rerunRequested = false;

  function findNextPendingCheck() {
    const checks = getChecks();
    if (!Array.isArray(checks)) return null;
    for (const id of expandedCheckIds) {
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
          } else if (!expandedCheckIds.has(checkId)) {
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
          if (!expandedCheckIds.has(checkId)) {
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
      if (outputCache.get(id)?.error) {
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

  return {
    drain,
    toggle,
    isInFlight: () => inFlight,
  };
}

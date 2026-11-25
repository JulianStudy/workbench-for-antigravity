import {
  App,
  applyDocumentTheme,
  applyHostStyleVariables,
} from '@modelcontextprotocol/ext-apps';
import {
  MAX_FAILURE_EVIDENCE_BYTES,
  attachFailureEvidenceContext,
  buildFailureEvidencePreview,
  canAttachFailureEvidence,
  clearErroredOutputCache,
  computeChecksRenderSignature,
  createExpandedOutputLoader,
  shouldShowReplaceEvidenceWarning,
} from './pane-state.mjs';

const STATE_LABELS = {
  not_run: '未运行',
  passed: '通过',
  failed: '失败',
  stale: '已过期',
  error: '执行错误',
  running: '运行中',
};

const overallBadgeEl = document.getElementById('overall-badge');
const countsSummaryEl = document.getElementById('counts-summary');
const projectRootEl = document.getElementById('project-root');
const runtimeInfoEl = document.getElementById('runtime-info');
const runAllBtn = document.getElementById('run-all-btn');
const refreshBtn = document.getElementById('refresh-btn');
const pollHintEl = document.getElementById('poll-hint');
const progressBannerEl = document.getElementById('progress-banner');
const errorBannerEl = document.getElementById('error-banner');
const skippedBannerEl = document.getElementById('skipped-banner');
const checksListEl = document.getElementById('checks-list');

let isConnected = false;
let pollInFlight = false;
let runInFlight = false;
let attachInFlight = false;
let attachInFlightCheckId = null;
let snapshotVersion = 0;
let lastSnapshot = null;
let lastChecksRenderSignature = null;
let transientActionError = null;
let lastAttachedEvidence = null;

// Track which check IDs currently have output expanded or failure preview open, plus cached output per check ID.
const expandedCheckIds = new Set();
const previewCheckIds = new Set();
const outputCache = new Map(); // id -> { finishedAt, output, outputTruncated, loading, error }
const attachFeedbackByCheckId = new Map(); // id -> { type: 'success' | 'error' | 'info', message }

function applyContext(ctx) {
  if (!ctx) return;
  if (ctx.theme) applyDocumentTheme(ctx.theme);
  if (ctx.styles?.variables) applyHostStyleVariables(ctx.styles.variables);
}

function setBadge(el, stateKey, label) {
  el.className = `badge badge-${stateKey}`;
  el.textContent = label;
}

function formatTime(iso) {
  if (!iso) return '-';
  try {
    const d = new Date(iso);
    return `${d.toLocaleString('zh-CN', { hour12: false })} (${iso})`;
  } catch {
    return iso;
  }
}

function computeOverallState(data) {
  if (!data || data.ok === false || data.configOk === false) {
    return { key: 'error', label: '配置/环境异常' };
  }
  if (data.isRunning || runInFlight) {
    return { key: 'running', label: data.runningBatch ? '批量运行中...' : '运行中...' };
  }
  const c = data.counts || { total: 0, not_run: 0, passed: 0, failed: 0, stale: 0, error: 0 };
  if (c.total === 0) return { key: 'not_run', label: '无检查项' };
  if (c.error > 0) return { key: 'error', label: '存在错误' };
  if (c.failed > 0) return { key: 'failed', label: '存在失败' };
  if (c.stale > 0) return { key: 'stale', label: '存在过期' };
  if (c.passed === c.total) return { key: 'passed', label: '全部通过' };
  return { key: 'not_run', label: '待运行' };
}

function formatCountsSummary(data) {
  if (!data || data.ok === false) {
    return '工作区绑定异常，已禁用执行';
  }
  if (data.configOk === false) {
    return '配置文件 workbench.json 无效或缺失';
  }
  const c = data.counts || { total: 0, not_run: 0, passed: 0, failed: 0, stale: 0, error: 0 };
  const base = `共 ${c.total} 项 · 通过 ${c.passed} · 失败 ${c.failed} · 过期 ${c.stale} · 未运行 ${c.not_run}`;
  return c.error > 0 ? `${base} · 错误 ${c.error}` : base;
}

function renderBanner(el, message) {
  if (!message) {
    el.textContent = '';
    el.classList.add('hidden');
    return;
  }
  el.textContent = message;
  el.classList.remove('hidden');
}

function renderSkippedBanner(skippedChecks) {
  if (!Array.isArray(skippedChecks) || skippedChecks.length === 0) {
    skippedBannerEl.innerHTML = '';
    skippedBannerEl.classList.add('hidden');
    return;
  }

  skippedBannerEl.innerHTML = '';
  const title = document.createElement('div');
  title.textContent = `最近一次批量运行跳过了 ${skippedChecks.length} 项（运行期间配置已变更）：`;
  skippedBannerEl.appendChild(title);

  const ul = document.createElement('ul');
  ul.className = 'file-list';
  for (const item of skippedChecks) {
    const li = document.createElement('li');
    li.textContent = `${item.name || item.id} (${item.id})：${item.reason}`;
    ul.appendChild(li);
  }
  skippedBannerEl.appendChild(ul);
  skippedBannerEl.classList.remove('hidden');
}

function isWorkspaceBusy() {
  return runInFlight || Boolean(lastSnapshot?.isRunning);
}

function syncTopButtons() {
  const busy = isWorkspaceBusy();
  const blocked =
    !lastSnapshot || lastSnapshot.ok === false || lastSnapshot.configOk === false || (lastSnapshot.checks || []).length === 0;
  runAllBtn.disabled = !isConnected || busy || blocked;
  runAllBtn.textContent = busy ? '运行中...' : '全部运行';
  refreshBtn.disabled = !isConnected || pollInFlight;
}

function getStaleReasonDescription(reason) {
  if (reason === 'config_changed') {
    return '该检查项配置已变更（command / files / timeoutMs 与上次记录不一致），上次结果已过期，请重新运行。';
  }
  if (reason === 'changed_between_before_and_after') {
    return '运行前后文件指纹不一致：检查执行期间受跟踪文件发生变化，结果保持过期，请重新运行。';
  }
  return '当前文件与上次检查记录不一致：检测到以下受跟踪文件已改动或缺失（下方保留上次检查证据）。';
}

function buildFailureEvidencePanel(check) {
  const panel = document.createElement('div');
  panel.className = 'evidence-panel';

  const eligible = canAttachFailureEvidence(check);
  const cached = outputCache.get(check.id);
  const feedback = attachFeedbackByCheckId.get(check.id);
  const isOutputReady = Boolean(
    check.lastRun &&
      cached &&
      !cached.loading &&
      !cached.error &&
      cached.finishedAt === check.lastRun.finishedAt
  );
  const isAttachingThis = attachInFlight && attachInFlightCheckId === check.id;

  const header = document.createElement('div');
  header.className = 'evidence-header';
  const titleSpan = document.createElement('span');
  titleSpan.textContent = '失败证据预览';
  const metaSpan = document.createElement('span');
  metaSpan.className = 'evidence-meta';

  let preview = null;
  if (!eligible) {
    metaSpan.textContent = '当前不可附加';
  } else if (cached?.error) {
    metaSpan.textContent = '加载失败';
  } else if (!isOutputReady) {
    metaSpan.textContent = '加载中...';
  } else {
    preview = buildFailureEvidencePreview({
      check,
      output: cached.output,
      projectRoot: lastSnapshot?.projectRoot || '',
    });
    metaSpan.textContent = `${preview.byteLength} / ${MAX_FAILURE_EVIDENCE_BYTES} 字节${preview.truncated ? ' · 已截断' : ''}`;
  }

  header.appendChild(titleSpan);
  header.appendChild(metaSpan);
  panel.appendChild(header);

  if (!eligible) {
    const warnBox = document.createElement('div');
    warnBox.className = 'notice notice-warning';
    if (check.isRunning) {
      warnBox.textContent = '检查正在重新运行，完成后请根据最新结果决定是否附加失败证据。';
    } else if (check.effectiveState === 'stale') {
      warnBox.textContent = '当前失败证据已过期，无法再附加。请先重新运行检查后再附加。';
    } else if (check.effectiveState === 'passed') {
      warnBox.textContent = '该检查项当前已通过，无需附加旧的失败证据。';
    } else {
      warnBox.textContent = '该检查项当前不是有效的失败状态，无法附加失败证据。';
    }
    panel.appendChild(warnBox);
  } else if (cached?.error) {
    const errBox = document.createElement('div');
    errBox.className = 'notice notice-danger';
    errBox.textContent = `加载检查输出失败：${cached.error}`;
    panel.appendChild(errBox);
  } else if (!isOutputReady) {
    const pre = document.createElement('pre');
    pre.className = 'evidence-preview mono';
    pre.textContent = '正在按需加载失败证据...';
    panel.appendChild(pre);
  } else {
    const pre = document.createElement('pre');
    pre.className = 'evidence-preview mono';
    pre.textContent = preview.text;
    panel.appendChild(pre);

    const explainHint = document.createElement('div');
    explainHint.className = 'hint';
    explainHint.textContent = '点击下方确认后仅附加到下一条消息上下文，不会自动发起对话。';
    panel.appendChild(explainHint);

    if (shouldShowReplaceEvidenceWarning({ check, lastAttachedEvidence, feedback })) {
      const replaceWarn = document.createElement('div');
      replaceWarn.className = 'notice notice-warning';
      replaceWarn.textContent = `注意：本次附加将替换上一次已附加的失败证据（${lastAttachedEvidence.name} / ${lastAttachedEvidence.id}）。`;
      panel.appendChild(replaceWarn);
    }
  }

  if (feedback?.message) {
    const feedbackEl = document.createElement('div');
    if (feedback.type === 'success') {
      feedbackEl.className = 'notice notice-success';
    } else if (feedback.type === 'error') {
      feedbackEl.className = 'notice notice-danger';
    } else {
      feedbackEl.className = 'notice notice-info';
    }
    feedbackEl.textContent = feedback.message;
    panel.appendChild(feedbackEl);
  }

  const actions = document.createElement('div');
  actions.className = 'evidence-actions';

  const confirmBtn = document.createElement('button');
  confirmBtn.type = 'button';
  confirmBtn.className = 'small primary';
  confirmBtn.textContent = isAttachingThis ? '附加中...' : '确认附加到下一条消息';
  confirmBtn.disabled = !isConnected || attachInFlight || !eligible || !isOutputReady;
  confirmBtn.addEventListener('click', () => {
    confirmAttachFailureEvidence(check.id);
  });
  actions.appendChild(confirmBtn);

  const closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.className = 'small';
  closeBtn.textContent = '关闭预览';
  closeBtn.disabled = isAttachingThis;
  closeBtn.addEventListener('click', () => {
    closeFailureEvidencePreview(check.id);
  });
  actions.appendChild(closeBtn);

  panel.appendChild(actions);
  return panel;
}

function buildCheckCard(check) {
  const card = document.createElement('section');
  card.className = 'card check-card';
  card.dataset.checkId = check.id;

  const busy = isWorkspaceBusy();
  const isThisRunning = Boolean(check.isRunning);

  // Header
  const header = document.createElement('div');
  header.className = 'check-header';

  const titleWrap = document.createElement('div');
  titleWrap.className = 'check-title-wrap';
  const nameEl = document.createElement('div');
  nameEl.className = 'check-name';
  nameEl.textContent = check.name;
  const idEl = document.createElement('div');
  idEl.className = 'check-id mono';
  idEl.textContent = `id: ${check.id} · timeout: ${check.timeoutMs} ms`;
  titleWrap.appendChild(nameEl);
  titleWrap.appendChild(idEl);

  const badgeEl = document.createElement('span');
  const badgeKey = isThisRunning ? 'running' : check.effectiveState || 'not_run';
  const badgeLabel = isThisRunning
    ? '运行中...'
    : STATE_LABELS[check.effectiveState] || check.effectiveState;
  setBadge(badgeEl, badgeKey, badgeLabel);

  header.appendChild(titleWrap);
  header.appendChild(badgeEl);
  card.appendChild(header);

  // Command preview
  const cmdEl = document.createElement('div');
  cmdEl.className = 'check-cmd mono';
  cmdEl.textContent = check.commandDisplay || (check.command || []).join(' ');
  card.appendChild(cmdEl);

  // Controls
  const controls = document.createElement('div');
  controls.className = 'check-controls';

  const runBtn = document.createElement('button');
  runBtn.type = 'button';
  runBtn.className = 'small';
  runBtn.textContent = isThisRunning ? '运行中...' : '运行';
  runBtn.disabled = !isConnected || busy;
  runBtn.addEventListener('click', () => {
    triggerRunSingleCheck(check.id);
  });
  controls.appendChild(runBtn);

  if (check.lastRun) {
    const isExpanded = expandedCheckIds.has(check.id);
    const toggleBtn = document.createElement('button');
    toggleBtn.type = 'button';
    toggleBtn.className = 'small';
    toggleBtn.textContent = isExpanded ? '收起输出' : '查看输出';
    toggleBtn.disabled = !isConnected;
    toggleBtn.addEventListener('click', () => {
      toggleCheckOutput(check.id);
    });
    controls.appendChild(toggleBtn);
  }

  if (canAttachFailureEvidence(check)) {
    const attachPreviewBtn = document.createElement('button');
    attachPreviewBtn.type = 'button';
    attachPreviewBtn.className = 'small';
    attachPreviewBtn.textContent = '附加失败证据';
    attachPreviewBtn.disabled = !isConnected;
    attachPreviewBtn.addEventListener('click', () => {
      toggleFailureEvidencePreview(check.id);
    });
    controls.appendChild(attachPreviewBtn);
  }

  card.appendChild(controls);

  if (check.effectiveState === 'stale' && check.lastRun?.status === 'failed') {
    const staleAttachHint = document.createElement('div');
    staleAttachHint.className = 'hint';
    staleAttachHint.textContent = '上次失败证据已过期，请先重新运行检查后再附加。';
    card.appendChild(staleAttachHint);
  }

  if (previewCheckIds.has(check.id)) {
    card.appendChild(buildFailureEvidencePanel(check));
  }

  // Per-check error banner (e.g. symlink escape)
  if (check.checkError) {
    const errBox = document.createElement('div');
    errBox.className = 'notice notice-danger';
    errBox.textContent = check.checkError;
    card.appendChild(errBox);
  }

  // Stale notice
  if (check.effectiveState === 'stale') {
    const staleBox = document.createElement('div');
    staleBox.className = 'notice notice-warning';
    const reasonDiv = document.createElement('div');
    reasonDiv.textContent = getStaleReasonDescription(check.staleReason);
    staleBox.appendChild(reasonDiv);

    if (Array.isArray(check.changedFiles) && check.changedFiles.length > 0) {
      const ul = document.createElement('ul');
      ul.className = 'file-list mono';
      for (const file of check.changedFiles) {
        const li = document.createElement('li');
        li.textContent = file;
        ul.appendChild(li);
      }
      staleBox.appendChild(ul);
    }
    card.appendChild(staleBox);
  }

  // Saved evidence metadata
  if (check.lastRun) {
    const lr = check.lastRun;
    const kv = document.createElement('div');
    kv.className = 'kv';

    const savedStatusText = STATE_LABELS[lr.status] || lr.status;
    let validityText = '执行错误（需排查后重跑）';
    if (check.effectiveState === 'stale') {
      validityText = '已过期（上次证据不再对应当前代码或配置）';
    } else if (check.isValid) {
      validityText = '当前有效（与配置及受跟踪文件指纹一致）';
    }

    const exitCodeText =
      lr.exitCode === null || lr.exitCode === undefined
        ? lr.timedOut
          ? '超时终止'
          : '无'
        : String(lr.exitCode);

    const rows = [
      ['已保存结果', savedStatusText, false],
      ['当前有效性', validityText, false],
      ['退出码', exitCodeText, true],
      ['检查时间', formatTime(lr.finishedAt), true],
      ['耗时', typeof lr.durationMs === 'number' ? `${lr.durationMs} ms` : '-', true],
    ];

    for (const [k, v, mono] of rows) {
      const kEl = document.createElement('div');
      kEl.className = 'kv-key';
      kEl.textContent = k;
      const vEl = document.createElement('div');
      vEl.className = mono ? 'kv-val mono' : 'kv-val';
      vEl.textContent = v;
      kv.appendChild(kEl);
      kv.appendChild(vEl);
    }
    card.appendChild(kv);

    // Lazy output section
    if (expandedCheckIds.has(check.id)) {
      const cached = outputCache.get(check.id);
      const wrap = document.createElement('div');
      wrap.className = 'output-wrap';

      const outHeader = document.createElement('div');
      outHeader.className = 'output-header';
      const labelSpan = document.createElement('span');
      labelSpan.textContent = '检查输出';
      const metaSpan = document.createElement('span');
      if (cached?.loading) {
        metaSpan.textContent = '加载中...';
      } else if (cached?.outputTruncated || lr.outputTruncated) {
        metaSpan.textContent = '输出已截断（上限 32 KiB）';
      }
      outHeader.appendChild(labelSpan);
      outHeader.appendChild(metaSpan);

      const pre = document.createElement('pre');
      pre.className = 'output mono';
      if (cached?.loading) {
        pre.textContent = '正在按需加载检查输出...';
      } else if (cached?.error) {
        pre.textContent = `加载输出失败: ${cached.error}`;
      } else if (cached) {
        pre.textContent = cached.output || '（无输出）';
      } else {
        pre.textContent = '正在按需加载检查输出...';
      }

      wrap.appendChild(outHeader);
      wrap.appendChild(pre);
      card.appendChild(wrap);
    }
  } else {
    const hint = document.createElement('div');
    hint.className = 'hint';
    hint.textContent = '尚未运行此检查项，点击「运行」或「全部运行」开始验证。';
    card.appendChild(hint);
  }

  return card;
}

function renderChecksList(data) {
  const sig = computeChecksRenderSignature({
    data,
    isConnected,
    busy: isWorkspaceBusy(),
    expandedCheckIds,
    previewCheckIds,
    outputCache,
    attachInFlight,
    attachInFlightCheckId,
    attachFeedbackByCheckId,
    lastAttachedEvidence,
  });
  if (sig === lastChecksRenderSignature) {
    return;
  }
  lastChecksRenderSignature = sig;

  checksListEl.innerHTML = '';

  if (!data || data.ok === false || data.configOk === false) {
    const empty = document.createElement('section');
    empty.className = 'card empty-state';
    empty.textContent =
      data?.rootError ||
      data?.configError ||
      '暂无可显示的验收检查项。请在工作区根目录检查 workbench.json。';
    checksListEl.appendChild(empty);
    return;
  }

  const checks = Array.isArray(data.checks) ? data.checks : [];
  if (checks.length === 0) {
    const empty = document.createElement('section');
    empty.className = 'card empty-state';
    empty.textContent = 'workbench.json 中未配置检查项。';
    checksListEl.appendChild(empty);
    return;
  }

  for (const check of checks) {
    checksListEl.appendChild(buildCheckCard(check));
  }
}

function renderSnapshot(data) {
  if (!data) return;
  lastSnapshot = data;

  // If checkDetail was bundled on single-check run, cache its output immediately.
  if (data.checkDetail?.ok && data.checkDetail.check?.lastRun) {
    const dc = data.checkDetail.check;
    outputCache.set(dc.id, {
      finishedAt: dc.lastRun.finishedAt,
      output: dc.lastRun.output || '',
      outputTruncated: Boolean(dc.lastRun.outputTruncated),
      loading: false,
      error: null,
    });
  }

  const overall = computeOverallState(data);
  setBadge(overallBadgeEl, overall.key, overall.label);
  countsSummaryEl.textContent = formatCountsSummary(data);
  projectRootEl.textContent = data.projectRoot || '-';
  runtimeInfoEl.textContent = data.nodeVersion ? `Node ${data.nodeVersion}` : '-';

  // Active progress banner
  if (data.isRunning && data.runningCheckId) {
    const prefix = data.runningBatch ? '批量运行中' : '正在运行';
    renderBanner(progressBannerEl, `${prefix}：${data.runningCheckId}`);
  } else if (data.isRunning) {
    renderBanner(progressBannerEl, data.runningBatch ? '批量运行中...' : '正在运行检查...');
  } else {
    renderBanner(progressBannerEl, null);
  }

  // Error banner
  const topError =
    data.rootError ||
    (data.configOk === false ? data.configError : null) ||
    data.persistenceError ||
    (data.ok === false ? data.error : null) ||
    transientActionError ||
    null;
  renderBanner(errorBannerEl, topError);

  // Skipped banner
  renderSkippedBanner(data.skippedChecks);

  // Clean up expanded / preview IDs that no longer exist, and clear stale attach feedback
  const checksById = new Map((data.checks || []).map((c) => [c.id, c]));
  for (const id of [...expandedCheckIds]) {
    if (!checksById.has(id)) {
      expandedCheckIds.delete(id);
      outputCache.delete(id);
    }
  }
  for (const id of [...previewCheckIds]) {
    if (!checksById.has(id)) {
      previewCheckIds.delete(id);
      attachFeedbackByCheckId.delete(id);
      outputCache.delete(id);
    }
  }
  for (const [id, feedback] of [...attachFeedbackByCheckId.entries()]) {
    const check = checksById.get(id);
    if (!canAttachFailureEvidence(check) || (feedback.finishedAt && check.lastRun?.finishedAt !== feedback.finishedAt)) {
      attachFeedbackByCheckId.delete(id);
    }
  }

  renderChecksList(data);
  syncTopButtons();

  // Trigger sequential lazy refresh for any expanded/previewed checks whose finishedAt changed
  void expandedOutputLoader.drain();
}

const app = new App({ name: 'Workbench', version: '0.1.0' }, {});

const expandedOutputLoader = createExpandedOutputLoader({
  getChecks: () => lastSnapshot?.checks || [],
  expandedCheckIds,
  previewCheckIds,
  outputCache,
  canFetch: () => isConnected,
  fetchDetail: async (id) => {
    const res = await app.callServerTool({
      name: 'workbench_get_status',
      arguments: { id },
    });
    return res?.structuredContent;
  },
  onStateChange: () => {
    if (lastSnapshot) renderChecksList(lastSnapshot);
  },
});

function toggleCheckOutput(id) {
  expandedOutputLoader.toggle(id);
}

function toggleFailureEvidencePreview(id) {
  if (previewCheckIds.has(id)) {
    closeFailureEvidencePreview(id);
    return;
  }
  attachFeedbackByCheckId.delete(id);
  expandedOutputLoader.openPreview(id);
}

function closeFailureEvidencePreview(id) {
  attachFeedbackByCheckId.delete(id);
  expandedOutputLoader.closePreview(id);
}

async function confirmAttachFailureEvidence(id) {
  if (!isConnected || attachInFlight) return;
  const check = (lastSnapshot?.checks || []).find((c) => c.id === id);
  if (!canAttachFailureEvidence(check)) {
    attachFeedbackByCheckId.set(id, {
      type: 'error',
      message: '当前检查项不是有效的失败状态，无法附加失败证据。',
    });
    if (lastSnapshot) renderChecksList(lastSnapshot);
    return;
  }

  const cached = outputCache.get(id);
  if (!cached || cached.loading || cached.error || cached.finishedAt !== check.lastRun.finishedAt) {
    return;
  }

  attachInFlight = true;
  attachInFlightCheckId = id;
  if (lastSnapshot) renderChecksList(lastSnapshot);

  try {
    const res = await attachFailureEvidenceContext({
      app,
      check,
      output: cached.output,
      projectRoot: lastSnapshot?.projectRoot || '',
    });
    if (res.ok && res.attached) {
      lastAttachedEvidence = res.attached;
      attachFeedbackByCheckId.set(id, {
        type: 'success',
        message: res.message,
        finishedAt: check.lastRun.finishedAt,
      });
    } else {
      attachFeedbackByCheckId.set(id, {
        type: 'error',
        message: res.message,
        finishedAt: check.lastRun.finishedAt,
      });
    }
  } finally {
    attachInFlight = false;
    attachInFlightCheckId = null;
    if (lastSnapshot) renderChecksList(lastSnapshot);
  }
}

// Register all handlers BEFORE app.connect() so no initial host event is missed.
app.ontoolinput = () => {
  pollHintEl.textContent = '正在加载最新状态...';
};

app.ontoolresult = (result) => {
  if (result?.structuredContent) {
    snapshotVersion += 1;
    renderSnapshot(result.structuredContent);
    pollHintEl.textContent = '每 2 秒自动检测文件变化';
  }
};

app.onhostcontextchanged = (ctx) => {
  applyContext(ctx);
};

async function refreshStatus({ manual = false } = {}) {
  if (!isConnected || pollInFlight) return;
  if (!manual && document.hidden) return;

  pollInFlight = true;
  const myVersion = ++snapshotVersion;
  syncTopButtons();
  try {
    const res = await app.callServerTool({
      name: 'workbench_get_status',
      arguments: {},
    });
    if (res?.structuredContent && myVersion === snapshotVersion) {
      if (manual) {
        transientActionError = null;
        clearErroredOutputCache(outputCache);
      }
      renderSnapshot(res.structuredContent);
      pollHintEl.textContent = `每 2 秒自动检测 · 上次刷新 ${new Date().toLocaleTimeString('zh-CN', { hour12: false })}`;
    }
  } catch (err) {
    if (manual) {
      transientActionError = `刷新状态失败: ${err?.message || String(err)}`;
      renderBanner(errorBannerEl, transientActionError);
    }
  } finally {
    pollInFlight = false;
    syncTopButtons();
  }
}

async function triggerRunSingleCheck(id) {
  if (!isConnected || runInFlight) return;
  runInFlight = true;
  transientActionError = null;
  syncTopButtons();
  if (lastSnapshot) renderChecksList(lastSnapshot);
  renderBanner(progressBannerEl, `正在运行：${id}`);
  pollHintEl.textContent = `正在运行检查 ${id}...`;

  try {
    const res = await app.callServerTool({
      name: 'workbench_run_check',
      arguments: { id },
    });
    runInFlight = false;
    if (res?.structuredContent) {
      snapshotVersion += 1;
      renderSnapshot(res.structuredContent);
      if (res.structuredContent.busy) {
        pollHintEl.textContent = '已有检查在运行，忽略重复触发';
      } else {
        pollHintEl.textContent = `检查 ${id} 完成 · ${new Date().toLocaleTimeString('zh-CN', { hour12: false })}`;
      }
    }
  } catch (err) {
    runInFlight = false;
    transientActionError = `运行检查 ${id} 失败: ${err?.message || String(err)}`;
    if (lastSnapshot) {
      renderSnapshot(lastSnapshot);
    } else {
      renderBanner(errorBannerEl, transientActionError);
      syncTopButtons();
    }
  }
}

async function triggerRunAll() {
  if (!isConnected || runInFlight) return;
  runInFlight = true;
  transientActionError = null;
  syncTopButtons();
  if (lastSnapshot) renderChecksList(lastSnapshot);
  renderBanner(progressBannerEl, '批量运行中...');
  pollHintEl.textContent = '正在按顺序运行全部检查...';

  try {
    const res = await app.callServerTool({
      name: 'workbench_run_all',
      arguments: {},
    });
    runInFlight = false;
    if (res?.structuredContent) {
      snapshotVersion += 1;
      renderSnapshot(res.structuredContent);
      if (res.structuredContent.busy) {
        pollHintEl.textContent = '已有检查在运行，忽略重复触发';
      } else {
        pollHintEl.textContent = `全部检查完成 · ${new Date().toLocaleTimeString('zh-CN', { hour12: false })}`;
      }
    }
  } catch (err) {
    runInFlight = false;
    transientActionError = `全部运行调用失败: ${err?.message || String(err)}`;
    if (lastSnapshot) {
      renderSnapshot(lastSnapshot);
    } else {
      renderBanner(errorBannerEl, transientActionError);
      syncTopButtons();
    }
  }
}

runAllBtn.addEventListener('click', () => {
  triggerRunAll();
});

refreshBtn.addEventListener('click', () => {
  refreshStatus({ manual: true });
});

document.addEventListener('visibilitychange', () => {
  if (!document.hidden && isConnected) {
    refreshStatus();
  }
});

async function init() {
  try {
    await app.connect();
    isConnected = true;
    applyContext(app.getHostContext());
    syncTopButtons();

    if (!lastSnapshot) {
      await refreshStatus();
    } else {
      renderChecksList(lastSnapshot);
      void expandedOutputLoader.drain();
    }

    setInterval(() => {
      refreshStatus();
    }, 2000);
  } catch (err) {
    setBadge(overallBadgeEl, 'error', '连接失败');
    transientActionError = `MCP App 初始化失败: ${err?.message || String(err)}`;
    renderBanner(errorBannerEl, transientActionError);
  }
}

init();

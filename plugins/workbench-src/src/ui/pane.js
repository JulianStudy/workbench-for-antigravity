import {
  App,
  applyDocumentTheme,
  applyHostStyleVariables,
} from '@modelcontextprotocol/ext-apps';
import {
  MAX_FAILURE_EVIDENCE_BYTES,
  attachFailureEvidenceContext,
  buildFailureEvidencePreview,
  buildScopedToolArgs,
  canAttachFailureEvidence,
  canRunChecksInPane,
  clearErroredOutputCache,
  computeChecksRenderSignature,
  computeWorkspaceSelectSignature,
  createClearedGlobalSnapshot,
  createExpandedOutputLoader,
  resolveNextTrustedWorkspaces,
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

const workspaceCardEl = document.getElementById('workspace-card');
const workspaceSelectEl = document.getElementById('workspace-select');
const toggleAddWorkspaceBtn = document.getElementById('toggle-add-workspace-btn');
const removeWorkspaceBtn = document.getElementById('remove-workspace-btn');
const addWorkspaceBoxEl = document.getElementById('add-workspace-box');
const workspacePathInputEl = document.getElementById('workspace-path-input');
const confirmAddWorkspaceBtn = document.getElementById('confirm-add-workspace-btn');
const cancelAddWorkspaceBtn = document.getElementById('cancel-add-workspace-btn');
const workspaceFeedbackEl = document.getElementById('workspace-feedback');

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
let latestPollId = 0;
let runInFlight = false;
let runInFlightEpoch = null;
let workspaceActionInFlight = false;
let attachInFlight = false;
let attachInFlightCheckId = null;
let currentMode = 'workspace';
let selectedWorkspaceId = '';
let workspaceSwitchEpoch = 0;
let snapshotVersion = 0;
let lastSnapshot = null;
let lastTrustedWorkspaces = [];
let lastWorkspaceSelectSignature = null;
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

function isGlobalUnbound(data) {
  return currentMode === 'global' && (!selectedWorkspaceId || !data || data.workspaceBound !== true);
}

function computeOverallState(data) {
  if (!data || data.ok === false || data.rootError) {
    return { key: 'error', label: '配置/环境异常' };
  }
  if (isGlobalUnbound(data)) {
    return { key: 'not_run', label: '未绑定' };
  }
  if (data.configOk === false) {
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
  if (!data || data.ok === false || data.rootError) {
    return '工作区绑定异常，已禁用执行';
  }
  if (isGlobalUnbound(data)) {
    return data.bindingError ? '所选工作区当前不可用，已禁用执行' : '当前侧栏尚未绑定受信任工作区';
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

function renderWorkspaceFeedback(type, message) {
  if (!message) {
    workspaceFeedbackEl.textContent = '';
    workspaceFeedbackEl.className = 'notice hidden';
    return;
  }
  const variant =
    type === 'success' ? 'notice-success' : type === 'error' ? 'notice-danger' : 'notice-info';
  workspaceFeedbackEl.className = `notice ${variant}`;
  workspaceFeedbackEl.textContent = message;
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

function isAnyActionBusy() {
  return isWorkspaceBusy() || workspaceActionInFlight;
}

function syncWorkspaceControls() {
  if (currentMode !== 'global') return;
  const busy = isAnyActionBusy();
  const globalReady = isConnected && !lastSnapshot?.rootError;
  workspaceSelectEl.disabled = !globalReady || workspaceActionInFlight;
  toggleAddWorkspaceBtn.disabled = !globalReady || workspaceActionInFlight;
  removeWorkspaceBtn.disabled = !globalReady || !selectedWorkspaceId || busy;
  workspacePathInputEl.disabled = !globalReady || workspaceActionInFlight;
  confirmAddWorkspaceBtn.disabled = !globalReady || workspaceActionInFlight;
  confirmAddWorkspaceBtn.textContent = workspaceActionInFlight ? '处理中...' : '信任并绑定';
  cancelAddWorkspaceBtn.disabled = workspaceActionInFlight;
}

function renderWorkspaceSelector(trustedWorkspaces) {
  if (currentMode !== 'global') return;
  const list = Array.isArray(trustedWorkspaces) ? trustedWorkspaces : [];
  const sig = computeWorkspaceSelectSignature(list, selectedWorkspaceId, workspaceActionInFlight);
  if (sig !== lastWorkspaceSelectSignature) {
    lastWorkspaceSelectSignature = sig;
    workspaceSelectEl.innerHTML = '';

    const defaultOpt = document.createElement('option');
    defaultOpt.value = '';
    defaultOpt.textContent = '请选择要绑定到此侧栏的工作区...';
    workspaceSelectEl.appendChild(defaultOpt);

    for (const ws of list) {
      const opt = document.createElement('option');
      opt.value = ws.id;
      const suffix = !ws.exists
        ? ' [目录不存在]'
        : !ws.hasConfig
          ? ' [无 workbench.json]'
          : '';
      opt.textContent = `${ws.label} (${ws.path})${suffix}`;
      workspaceSelectEl.appendChild(opt);
    }
    workspaceSelectEl.value = selectedWorkspaceId || '';
  }
  syncWorkspaceControls();
}

function syncTopButtons() {
  const busy = isAnyActionBusy();
  const canRun = canRunChecksInPane({
    data: lastSnapshot,
    isConnected,
    busy,
    mode: currentMode,
    selectedWorkspaceId,
  });
  runAllBtn.disabled = !canRun || (lastSnapshot?.checks || []).length === 0;
  runAllBtn.textContent = isWorkspaceBusy() ? '运行中...' : '全部运行';
  refreshBtn.disabled = !isConnected || pollInFlight || workspaceActionInFlight;
  syncWorkspaceControls();
}

function resetPerPaneWorkspaceState() {
  workspaceSwitchEpoch += 1;
  snapshotVersion += 1;
  runInFlight = false;
  runInFlightEpoch = null;
  expandedCheckIds.clear();
  previewCheckIds.clear();
  outputCache.clear();
  attachFeedbackByCheckId.clear();
  lastChecksRenderSignature = null;
  transientActionError = null;
  if (currentMode === 'global' && lastSnapshot) {
    lastSnapshot = createClearedGlobalSnapshot(lastSnapshot, lastTrustedWorkspaces);
  }
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

  const busy = isAnyActionBusy();
  const isThisRunning = Boolean(check.isRunning);
  const canRun = canRunChecksInPane({
    data: lastSnapshot,
    isConnected,
    busy,
    mode: currentMode,
    selectedWorkspaceId,
  });

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
  runBtn.disabled = !canRun;
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
    busy: isAnyActionBusy(),
    mode: currentMode,
    selectedWorkspaceId,
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

  if (!data || data.ok === false || data.rootError) {
    const empty = document.createElement('section');
    empty.className = 'card empty-state';
    empty.textContent =
      data?.rootError ||
      data?.error ||
      '暂无可显示的验收检查项。请在工作区根目录检查 workbench.json。';
    checksListEl.appendChild(empty);
    return;
  }

  if (isGlobalUnbound(data)) {
    const empty = document.createElement('section');
    empty.className = 'card empty-state';
    empty.textContent =
      '请先在上方选择或添加一个受信任工作区，再查看或运行该项目的验收清单。';
    checksListEl.appendChild(empty);
    return;
  }

  if (data.configOk === false) {
    const empty = document.createElement('section');
    empty.className = 'card empty-state';
    empty.textContent =
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

  if (data.mode === 'global' || data.mode === 'workspace') {
    currentMode = data.mode;
  }

  if (currentMode === 'global') {
    workspaceCardEl.classList.remove('hidden');
    if (Array.isArray(data.trustedWorkspaces)) {
      lastTrustedWorkspaces = data.trustedWorkspaces;
    }
    if (
      data.bindingError &&
      selectedWorkspaceId &&
      (!data.selectedWorkspace ||
        !lastTrustedWorkspaces.some((ws) => ws.id === selectedWorkspaceId))
    ) {
      selectedWorkspaceId = '';
      workspaceSwitchEpoch += 1;
      runInFlight = false;
      runInFlightEpoch = null;
      transientActionError = data.bindingError;
      expandedCheckIds.clear();
      previewCheckIds.clear();
      outputCache.clear();
      attachFeedbackByCheckId.clear();
      lastChecksRenderSignature = null;
    }
    renderWorkspaceSelector(lastTrustedWorkspaces);
  } else {
    workspaceCardEl.classList.add('hidden');
  }

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

  const globalUnbound = isGlobalUnbound(data);
  const overall = computeOverallState(data);
  setBadge(overallBadgeEl, overall.key, overall.label);
  countsSummaryEl.textContent = formatCountsSummary(data);
  projectRootEl.textContent =
    globalUnbound && !data.rootError ? '未选择工作区' : data.projectRoot || '-';
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
    data.bindingError ||
    (data.ok !== false && !globalUnbound && data.configOk === false ? data.configError : null) ||
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

const app = new App({ name: 'Workbench', version: '0.2.0' }, {});

const expandedOutputLoader = createExpandedOutputLoader({
  getChecks: () => lastSnapshot?.checks || [],
  expandedCheckIds,
  previewCheckIds,
  outputCache,
  canFetch: () =>
    isConnected &&
    (currentMode !== 'global' || Boolean(selectedWorkspaceId && lastSnapshot?.workspaceBound)),
  fetchDetail: async (id) => {
    const reqEpoch = workspaceSwitchEpoch;
    try {
      const res = await app.callServerTool({
        name: 'workbench_get_status',
        arguments: buildScopedToolArgs({
          mode: currentMode,
          workspaceId: selectedWorkspaceId,
          extra: { id },
        }),
      });
      if (reqEpoch !== workspaceSwitchEpoch) {
        return { discarded: true };
      }
      return res?.structuredContent;
    } catch (err) {
      if (reqEpoch !== workspaceSwitchEpoch) {
        return { discarded: true };
      }
      throw err;
    }
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

  const reqEpoch = workspaceSwitchEpoch;
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
    }
    if (reqEpoch === workspaceSwitchEpoch) {
      attachFeedbackByCheckId.set(id, {
        type: res.ok ? 'success' : 'error',
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
  if (result?.structuredContent && workspaceSwitchEpoch === 0) {
    snapshotVersion += 1;
    renderSnapshot(result.structuredContent);
    pollHintEl.textContent = '每 2 秒自动检测文件变化';
  }
};

app.onhostcontextchanged = (ctx) => {
  applyContext(ctx);
};

async function refreshStatus({ manual = false, force = false } = {}) {
  if (!isConnected) return;
  if (!force && pollInFlight) return;
  if (!manual && !force && document.hidden) return;

  const myPollId = ++latestPollId;
  pollInFlight = true;
  const myVersion = ++snapshotVersion;
  const reqEpoch = workspaceSwitchEpoch;
  syncTopButtons();
  try {
    const res = await app.callServerTool({
      name: 'workbench_get_status',
      arguments: buildScopedToolArgs({
        mode: currentMode,
        workspaceId: selectedWorkspaceId,
      }),
    });
    if (
      res?.structuredContent &&
      reqEpoch === workspaceSwitchEpoch &&
      myVersion === snapshotVersion
    ) {
      if (manual) {
        transientActionError = null;
        clearErroredOutputCache(outputCache);
      }
      renderSnapshot(res.structuredContent);
      pollHintEl.textContent = `每 2 秒自动检测 · 上次刷新 ${new Date().toLocaleTimeString('zh-CN', { hour12: false })}`;
    }
  } catch (err) {
    if (reqEpoch === workspaceSwitchEpoch && (manual || force)) {
      transientActionError = `刷新状态失败: ${err?.message || String(err)}`;
      renderBanner(errorBannerEl, transientActionError);
    }
  } finally {
    if (myPollId === latestPollId) {
      pollInFlight = false;
    }
    syncTopButtons();
  }
}

async function triggerRunSingleCheck(id) {
  if (
    !canRunChecksInPane({
      data: lastSnapshot,
      isConnected,
      busy: isAnyActionBusy(),
      mode: currentMode,
      selectedWorkspaceId,
    })
  ) {
    return;
  }
  const reqEpoch = workspaceSwitchEpoch;
  runInFlight = true;
  runInFlightEpoch = reqEpoch;
  transientActionError = null;
  syncTopButtons();
  if (lastSnapshot) renderChecksList(lastSnapshot);
  renderBanner(progressBannerEl, `正在运行：${id}`);
  pollHintEl.textContent = `正在运行检查 ${id}...`;

  try {
    const res = await app.callServerTool({
      name: 'workbench_run_check',
      arguments: buildScopedToolArgs({
        mode: currentMode,
        workspaceId: selectedWorkspaceId,
        extra: { id },
      }),
    });
    if (reqEpoch === runInFlightEpoch) {
      runInFlight = false;
      runInFlightEpoch = null;
    }
    if (reqEpoch !== workspaceSwitchEpoch) {
      return;
    }
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
    if (reqEpoch === runInFlightEpoch) {
      runInFlight = false;
      runInFlightEpoch = null;
    }
    if (reqEpoch !== workspaceSwitchEpoch) {
      return;
    }
    transientActionError = `运行检查 ${id} 失败: ${err?.message || String(err)}`;
    if (lastSnapshot) {
      renderSnapshot(lastSnapshot);
    } else {
      renderBanner(errorBannerEl, transientActionError);
    }
  } finally {
    if (reqEpoch === runInFlightEpoch) {
      runInFlight = false;
      runInFlightEpoch = null;
    }
    syncTopButtons();
  }
}

async function triggerRunAll() {
  if (
    !canRunChecksInPane({
      data: lastSnapshot,
      isConnected,
      busy: isAnyActionBusy(),
      mode: currentMode,
      selectedWorkspaceId,
    })
  ) {
    return;
  }
  const reqEpoch = workspaceSwitchEpoch;
  runInFlight = true;
  runInFlightEpoch = reqEpoch;
  transientActionError = null;
  syncTopButtons();
  if (lastSnapshot) renderChecksList(lastSnapshot);
  renderBanner(progressBannerEl, '批量运行中...');
  pollHintEl.textContent = '正在按顺序运行全部检查...';

  try {
    const res = await app.callServerTool({
      name: 'workbench_run_all',
      arguments: buildScopedToolArgs({
        mode: currentMode,
        workspaceId: selectedWorkspaceId,
      }),
    });
    if (reqEpoch === runInFlightEpoch) {
      runInFlight = false;
      runInFlightEpoch = null;
    }
    if (reqEpoch !== workspaceSwitchEpoch) {
      return;
    }
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
    if (reqEpoch === runInFlightEpoch) {
      runInFlight = false;
      runInFlightEpoch = null;
    }
    if (reqEpoch !== workspaceSwitchEpoch) {
      return;
    }
    transientActionError = `全部运行调用失败: ${err?.message || String(err)}`;
    if (lastSnapshot) {
      renderSnapshot(lastSnapshot);
    } else {
      renderBanner(errorBannerEl, transientActionError);
    }
  } finally {
    if (reqEpoch === runInFlightEpoch) {
      runInFlight = false;
      runInFlightEpoch = null;
    }
    syncTopButtons();
  }
}

async function handleAddTrustedWorkspace() {
  if (!isConnected || currentMode !== 'global' || workspaceActionInFlight) return;
  const rawPath = workspacePathInputEl.value.trim();
  if (!rawPath) {
    renderWorkspaceFeedback('error', '请输入工作区的绝对路径。');
    workspacePathInputEl.focus();
    return;
  }

  let shouldRefresh = false;
  workspaceActionInFlight = true;
  renderWorkspaceFeedback(null);
  syncTopButtons();
  try {
    const res = await app.callServerTool({
      name: 'workbench_add_trusted_workspace',
      arguments: { workspacePath: rawPath },
    });
    const payload = res?.structuredContent;
    lastTrustedWorkspaces = resolveNextTrustedWorkspaces(lastTrustedWorkspaces, payload);
    if (payload?.ok && payload.addedWorkspace?.id) {
      addWorkspaceBoxEl.classList.add('hidden');
      workspacePathInputEl.value = '';
      selectedWorkspaceId = payload.addedWorkspace.id;
      resetPerPaneWorkspaceState();
      renderWorkspaceFeedback('success', `已信任并绑定工作区：${payload.addedWorkspace.label}`);
      shouldRefresh = true;
    } else {
      renderWorkspaceFeedback('error', payload?.error || '添加受信任工作区失败。');
    }
  } catch (err) {
    renderWorkspaceFeedback('error', `添加受信任工作区失败: ${err?.message || String(err)}`);
  } finally {
    workspaceActionInFlight = false;
    if (shouldRefresh && lastSnapshot) {
      renderSnapshot(lastSnapshot);
    } else {
      renderWorkspaceSelector(lastTrustedWorkspaces);
      syncTopButtons();
    }
  }

  if (shouldRefresh) {
    await refreshStatus({ manual: true, force: true });
  }
}

async function handleRemoveTrustedWorkspace() {
  if (!isConnected || currentMode !== 'global' || !selectedWorkspaceId || isAnyActionBusy()) {
    return;
  }
  const targetId = selectedWorkspaceId;
  let shouldRefresh = false;
  workspaceActionInFlight = true;
  renderWorkspaceFeedback(null);
  syncTopButtons();
  try {
    const res = await app.callServerTool({
      name: 'workbench_remove_trusted_workspace',
      arguments: { workspaceId: targetId },
    });
    const payload = res?.structuredContent;
    lastTrustedWorkspaces = resolveNextTrustedWorkspaces(lastTrustedWorkspaces, payload);
    if (payload?.ok) {
      selectedWorkspaceId = '';
      resetPerPaneWorkspaceState();
      renderWorkspaceFeedback(
        'info',
        '已从受信任列表移除该工作区（本地项目文件与检查记录未被删除）。'
      );
      shouldRefresh = true;
    } else {
      renderWorkspaceFeedback('error', payload?.error || '移除受信任工作区失败。');
    }
  } catch (err) {
    renderWorkspaceFeedback('error', `移除受信任工作区失败: ${err?.message || String(err)}`);
  } finally {
    workspaceActionInFlight = false;
    if (shouldRefresh && lastSnapshot) {
      renderSnapshot(lastSnapshot);
    } else {
      renderWorkspaceSelector(lastTrustedWorkspaces);
      syncTopButtons();
    }
  }

  if (shouldRefresh) {
    await refreshStatus({ manual: true, force: true });
  }
}

workspaceSelectEl.addEventListener('change', () => {
  if (currentMode !== 'global' || workspaceActionInFlight) return;
  selectedWorkspaceId = workspaceSelectEl.value || '';
  renderWorkspaceFeedback(null);
  resetPerPaneWorkspaceState();
  if (lastSnapshot) {
    renderSnapshot(lastSnapshot);
  } else {
    renderWorkspaceSelector(lastTrustedWorkspaces);
    syncTopButtons();
  }
  void refreshStatus({ manual: true, force: true });
});

toggleAddWorkspaceBtn.addEventListener('click', () => {
  if (currentMode !== 'global' || workspaceActionInFlight) return;
  const isHidden = addWorkspaceBoxEl.classList.contains('hidden');
  renderWorkspaceFeedback(null);
  if (isHidden) {
    addWorkspaceBoxEl.classList.remove('hidden');
    workspacePathInputEl.focus();
  } else {
    addWorkspaceBoxEl.classList.add('hidden');
  }
});

cancelAddWorkspaceBtn.addEventListener('click', () => {
  if (workspaceActionInFlight) return;
  addWorkspaceBoxEl.classList.add('hidden');
  workspacePathInputEl.value = '';
  renderWorkspaceFeedback(null);
});

confirmAddWorkspaceBtn.addEventListener('click', () => {
  void handleAddTrustedWorkspace();
});

workspacePathInputEl.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') {
    event.preventDefault();
    void handleAddTrustedWorkspace();
  }
});

removeWorkspaceBtn.addEventListener('click', () => {
  void handleRemoveTrustedWorkspace();
});

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

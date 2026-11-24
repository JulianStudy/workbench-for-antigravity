import {
  App,
  applyDocumentTheme,
  applyHostStyleVariables,
} from '@modelcontextprotocol/ext-apps';

const STATE_LABELS = {
  not_run: '未运行',
  passed: '通过',
  failed: '失败',
  stale: '已过期',
  error: '执行错误',
};

const stateBadgeEl = document.getElementById('state-badge');
const criterionEl = document.getElementById('criterion-text');
const projectRootEl = document.getElementById('project-root');
const checkCommandEl = document.getElementById('check-command');
const runtimeInfoEl = document.getElementById('runtime-info');
const runBtn = document.getElementById('run-btn');
const refreshBtn = document.getElementById('refresh-btn');
const pollHintEl = document.getElementById('poll-hint');
const errorBannerEl = document.getElementById('error-banner');
const validityBadgeEl = document.getElementById('validity-badge');
const staleBoxEl = document.getElementById('stale-box');
const staleReasonEl = document.getElementById('stale-reason-text');
const changedFilesEl = document.getElementById('changed-files-list');
const savedStatusEl = document.getElementById('saved-status');
const validityTextEl = document.getElementById('validity-text');
const exitCodeEl = document.getElementById('exit-code');
const checkedAtEl = document.getElementById('checked-at');
const durationEl = document.getElementById('duration-ms');
const recordedRootEl = document.getElementById('recorded-root');
const outputMetaEl = document.getElementById('output-meta');
const outputEl = document.getElementById('check-output');

let isConnected = false;
let pollInFlight = false;
let runInFlight = false;
let lastSnapshot = null;

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

function showErrorBanner(message) {
  if (!message) {
    errorBannerEl.textContent = '';
    errorBannerEl.classList.add('hidden');
    return;
  }
  errorBannerEl.textContent = message;
  errorBannerEl.classList.remove('hidden');
}

function syncButtons() {
  const busy = runInFlight || Boolean(lastSnapshot?.isRunning);
  const rootBroken = lastSnapshot && lastSnapshot.ok === false;
  runBtn.disabled = !isConnected || busy || rootBroken;
  runBtn.textContent = busy ? '检查运行中...' : '运行检查';
  refreshBtn.disabled = !isConnected || pollInFlight;
}

function renderSnapshot(data) {
  if (!data) return;
  lastSnapshot = data;

  const state = data.effectiveState || 'not_run';
  const stateLabel = data.isRunning
    ? '运行中...'
    : STATE_LABELS[state] || state;
  setBadge(stateBadgeEl, data.isRunning ? 'stale' : state, stateLabel);

  criterionEl.textContent = data.criterion || '1250 分显示为 ¥12.50';
  projectRootEl.textContent = data.projectRoot || '-';
  checkCommandEl.textContent = data.command || '-';
  runtimeInfoEl.textContent = data.nodeVersion ? `Node ${data.nodeVersion}` : '-';

  const topError = data.rootError || data.persistenceError || null;
  showErrorBanner(topError);

  const lastRun = data.lastRun;
  if (!lastRun) {
    setBadge(validityBadgeEl, state === 'error' ? 'error' : 'not_run', state === 'error' ? '记录异常' : '暂无记录');
    savedStatusEl.textContent = state === 'error' ? '持久化记录不可用' : '暂无记录';
    validityTextEl.textContent = state === 'error' ? '需重新运行检查覆盖' : '尚未运行';
    exitCodeEl.textContent = '-';
    checkedAtEl.textContent = '-';
    durationEl.textContent = '-';
    recordedRootEl.textContent = '-';
    staleBoxEl.classList.add('hidden');
    changedFilesEl.innerHTML = '';
    outputMetaEl.textContent = '';
    outputEl.textContent = topError || '尚未运行检查，点击「运行检查」开始验证。';
  } else {
    const savedLabel = STATE_LABELS[lastRun.status] || lastRun.status;
    savedStatusEl.textContent = savedLabel;

    if (state === 'stale') {
      setBadge(validityBadgeEl, 'stale', '已过期');
      validityTextEl.textContent = '已过期（上次检查证据不再对应当前源码）';
      staleBoxEl.classList.remove('hidden');
      if (data.staleReason === 'changed_between_before_and_after') {
        staleReasonEl.textContent =
          '运行前后指纹不同：本次检查开始与结束时受跟踪文件不一致，结果保持过期，请重新运行检查。';
      } else {
        staleReasonEl.textContent =
          '当前文件与上次检查记录不一致：检测到以下受跟踪文件已改动或缺失（下方保留上次检查证据）。';
      }
      changedFilesEl.innerHTML = '';
      for (const file of data.changedFiles || []) {
        const li = document.createElement('li');
        li.textContent = file;
        changedFilesEl.appendChild(li);
      }
    } else if (data.isValid) {
      setBadge(validityBadgeEl, lastRun.status, '当前有效');
      validityTextEl.textContent = '当前有效（与受跟踪文件指纹一致）';
      staleBoxEl.classList.add('hidden');
      changedFilesEl.innerHTML = '';
    } else {
      setBadge(validityBadgeEl, 'error', '执行异常');
      validityTextEl.textContent = '执行错误（需排查后重跑）';
      staleBoxEl.classList.add('hidden');
      changedFilesEl.innerHTML = '';
    }

    exitCodeEl.textContent =
      lastRun.exitCode === null || lastRun.exitCode === undefined
        ? lastRun.timedOut
          ? '超时终止'
          : '无'
        : String(lastRun.exitCode);
    checkedAtEl.textContent = formatTime(lastRun.finishedAt);
    durationEl.textContent =
      typeof lastRun.durationMs === 'number' ? `${lastRun.durationMs} ms` : '-';
    recordedRootEl.textContent = lastRun.projectRoot || '-';

    outputMetaEl.textContent = lastRun.outputTruncated ? '输出已截断（上限 32 KiB）' : '';
    outputEl.textContent = lastRun.output || '（无输出）';
  }

  syncButtons();
}

const app = new App({ name: 'Workbench', version: '0.1.0' }, {});

// Register all handlers BEFORE app.connect() so no initial host event is missed.
app.ontoolinput = () => {
  pollHintEl.textContent = '正在加载最新状态...';
};

app.ontoolresult = (result) => {
  if (result?.structuredContent) {
    renderSnapshot(result.structuredContent);
    pollHintEl.textContent = '每 2 秒自动检测文件变化';
  }
};

app.onhostcontextchanged = (ctx) => {
  applyContext(ctx);
};

async function refreshStatus({ manual = false } = {}) {
  if (!isConnected || pollInFlight || runInFlight) return;
  if (!manual && document.hidden) return;

  pollInFlight = true;
  syncButtons();
  try {
    const res = await app.callServerTool({
      name: 'workbench_get_status',
      arguments: {},
    });
    if (res?.structuredContent) {
      renderSnapshot(res.structuredContent);
      pollHintEl.textContent = `每 2 秒自动检测 · 上次刷新 ${new Date().toLocaleTimeString('zh-CN', { hour12: false })}`;
    }
  } catch (err) {
    if (manual) {
      showErrorBanner(`刷新状态失败: ${err?.message || String(err)}`);
    }
  } finally {
    pollInFlight = false;
    syncButtons();
  }
}

async function triggerRunCheck() {
  if (!isConnected || runInFlight) return;
  runInFlight = true;
  showErrorBanner(null);
  syncButtons();
  pollHintEl.textContent = '正在运行检查...';

  try {
    const res = await app.callServerTool({
      name: 'workbench_run_check',
      arguments: {},
    });
    if (res?.structuredContent) {
      renderSnapshot(res.structuredContent);
      if (res.structuredContent.busy) {
        pollHintEl.textContent = '已有检查在运行，忽略重复触发';
      } else {
        pollHintEl.textContent = `检查完成 · ${new Date().toLocaleTimeString('zh-CN', { hour12: false })}`;
      }
    }
  } catch (err) {
    showErrorBanner(`运行检查调用失败: ${err?.message || String(err)}`);
  } finally {
    runInFlight = false;
    syncButtons();
  }
}

runBtn.addEventListener('click', () => {
  triggerRunCheck();
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
    syncButtons();

    // If opened without an initial toolresult yet, pull status explicitly.
    if (!lastSnapshot) {
      await refreshStatus();
    }

    setInterval(() => {
      refreshStatus();
    }, 2000);
  } catch (err) {
    setBadge(stateBadgeEl, 'error', '连接失败');
    showErrorBanner(`MCP App 初始化失败: ${err?.message || String(err)}`);
  }
}

init();

import {
  App,
  applyDocumentTheme,
  applyHostStyleVariables,
} from '@modelcontextprotocol/ext-apps';

const rootEl = document.getElementById('project-root');
const nodeVersionEl = document.getElementById('node-version');
const execPathEl = document.getElementById('exec-path');
const pingBtn = document.getElementById('ping-btn');
const connStatusEl = document.getElementById('conn-status');
const pingOutputEl = document.getElementById('ping-output');

function applyContext(ctx) {
  if (!ctx) return;
  if (ctx.theme) applyDocumentTheme(ctx.theme);
  if (ctx.styles?.variables) applyHostStyleVariables(ctx.styles.variables);
}

function renderSnapshot(data) {
  if (!data) return;
  if (data.ok) {
    rootEl.textContent = data.projectRoot || '-';
    rootEl.classList.remove('error');
  } else {
    rootEl.textContent = data.rootError || '无法定位项目根目录';
    rootEl.classList.add('error');
  }
  nodeVersionEl.textContent = data.nodeVersion || '-';
  execPathEl.textContent = data.execPath || '-';
}

const app = new App({ name: 'Workbench', version: '0.1.0' }, {});

// Register handlers BEFORE app.connect() so no initial notification is missed.
app.ontoolinput = () => {
  connStatusEl.textContent = '正在加载侧栏状态...';
};

app.ontoolresult = (result) => {
  const data = result?.structuredContent;
  if (data) {
    renderSnapshot(data);
    connStatusEl.textContent = data.ok ? '已连接' : '根目录异常';
  }
};

app.onhostcontextchanged = (ctx) => {
  applyContext(ctx);
};

async function init() {
  try {
    await app.connect();
    applyContext(app.getHostContext());
    pingBtn.disabled = false;
    if (connStatusEl.textContent === '初始化 MCP App...') {
      connStatusEl.textContent = '已就绪';
    }
  } catch (err) {
    connStatusEl.textContent = '连接失败';
    pingOutputEl.textContent = `connect() 错误: ${err?.message || String(err)}`;
    pingOutputEl.classList.add('error');
  }
}

pingBtn.addEventListener('click', async () => {
  pingBtn.disabled = true;
  pingOutputEl.classList.remove('error', 'ok');
  pingOutputEl.textContent = '正在调用 workbench_ping...';
  try {
    const res = await app.callServerTool({
      name: 'workbench_ping',
      arguments: {},
    });
    const data = res?.structuredContent;
    if (data) {
      renderSnapshot(data);
      pingOutputEl.textContent =
        `确认值: ${data.pong}\n` +
        `检查目录: ${data.projectRoot || data.rootError}\n` +
        `Node: ${data.nodeVersion}\n` +
        `时间: ${data.timestamp}`;
      pingOutputEl.classList.add(data.ok ? 'ok' : 'error');
    } else {
      const text = res?.content?.map((c) => c.text).join('\n') || JSON.stringify(res);
      pingOutputEl.textContent = text;
    }
  } catch (err) {
    pingOutputEl.textContent = `调用失败: ${err?.message || String(err)}`;
    pingOutputEl.classList.add('error');
  } finally {
    pingBtn.disabled = false;
  }
});

init();

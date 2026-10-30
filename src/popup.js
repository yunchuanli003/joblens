/* popup：只做展示与转发，不持有业务逻辑 */
'use strict';

const C = window.BossCore || {};
const DEFAULTS = (C && C.DEFAULTS) || {
  limits: { daily_apply_max: 30, session_apply_max: 8 },
  pacing: { delay_min_sec: 25, delay_max_sec: 70 }
};

const $ = (id) => document.getElementById(id);

function todayStr() {
  const d = new Date();
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

function getStore(keys) {
  return new Promise((res) => chrome.storage.local.get(keys, (v) => res(v || {})));
}

function setStore(obj) {
  return new Promise((res) => chrome.storage.local.set(obj, res));
}

/* 读当前活动标签页；只有具备 host 权限时 url 才可见 */
function activeTab() {
  return new Promise((res) => {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => res(tabs && tabs[0]));
  });
}

function send(tabId, msg) {
  return new Promise((res) => {
    try {
      chrome.tabs.sendMessage(tabId, msg, (r) => {
        if (chrome.runtime.lastError) res(null);
        else res(r || null);
      });
    } catch (e) { res(null); }
  });
}

let TAB = null;
let CFG = DEFAULTS;
let STATS = { date: '', applied: 0 };

function paint(state) {
  const today = STATS.date === todayStr() ? (STATS.applied || 0) : 0;
  const cap = (CFG.limits && CFG.limits.daily_apply_max) || 30;
  const sessionMax = (CFG.limits && CFG.limits.session_apply_max) || 8;

  $('s-today').textContent = today;
  $('s-today').className = today >= cap ? 'warn' : (today >= cap * 0.6 ? 'warn' : 'cap');
  $('s-session').textContent = state ? (state.applied || 0) : 0;
  $('s-hit').textContent = state ? (state.hit || 0) : 0;

  const pct = Math.min(100, Math.round((today / cap) * 100));
  const bar = $('bar');
  bar.style.width = pct + '%';
  bar.className = pct >= 100 ? 'full' : (pct >= 60 ? 'warn' : '');

  $('quota').textContent = `额度 ${today} / ${cap} · 单轮 ${sessionMax}`;

  const dot = $('dot');
  if (!state) {
    dot.className = 'dot';
    $('site').textContent = '未在 BOSS 页面';
  } else {
    dot.className = 'dot' + (state.running ? ' on' : '');
    $('site').textContent = state.running ? '投递中' : '已连接';
  }

  $('btn-scan').disabled = !state || state.running;
  $('btn-refresh').disabled = !state || state.running;
  $('btn-start').disabled = !state || state.running || today >= cap;
  $('btn-stop').disabled = !state || !state.running;
  if (!state) $('rep').hidden = true;

  if (state && state.running) {
    $('status').textContent = `运行中 · 已扫描 ${state.cards || 0} 个 · 本轮完成 ${state.applied || 0} 份`;
  } else if (state) {
    $('status').textContent = state.cards
      ? `已扫描 ${state.cards} 个岗位，推荐 ${state.hit || 0} 个。点「开始投递」进入确认。`
      : '点「扫描打分」先看匹配结果，扫描过程不点击任何岗位。';
  } else {
    $('status').textContent = '打开 BOSS 直聘岗位列表页（/web/geek/jobs）后使用。';
  }

  // 额度预警：把边界条件显式说清楚，而不是让用户自己猜
  const warn = $('warn');
  if (today >= cap) {
    warn.className = 'warnbox show';
    warn.textContent = `今日额度已用满（${today}/${cap}）。建议明天再来，或先在设置里下调单轮上限——连续大量投递是账号受限最主要的原因。`;
  } else if (today >= cap * 0.7) {
    warn.className = 'warnbox show';
    warn.textContent = `今日已投 ${today} 份，接近上限。建议分时段、分批进行。`;
  } else {
    warn.className = 'warnbox';
  }
}

async function refresh() {
  const v = await getStore(['config', 'stats']);
  CFG = C.deepMerge ? C.deepMerge(DEFAULTS, v.config || {}) : DEFAULTS;
  STATS = v.stats || { date: '', applied: 0 };

  TAB = await activeTab();
  let state = null;
  if (TAB && TAB.id != null) {
    const pong = await send(TAB.id, { type: 'ping' });
    if (pong && pong.ok) state = pong;
  }
  paint(state);
}

$('btn-scan').addEventListener('click', async () => {
  if (!TAB) return;
  $('status').textContent = '扫描中…（滚动加载、只读不点）';
  $('btn-scan').disabled = true;
  const r = await send(TAB.id, { type: 'scan' });
  $('status').textContent = r && r.ok
    ? `扫描完成：${r.cards} 个岗位，推荐 ${r.hit} 个。`
    : '扫描失败，请确认已在岗位列表页并刷新一次。';
  await refresh();
});

$('btn-start').addEventListener('click', async () => {
  if (!TAB) return;
  const cap = (CFG.limits && CFG.limits.daily_apply_max) || 30;
  const today = STATS.date === todayStr() ? (STATS.applied || 0) : 0;
  if (today >= cap) {
    $('status').textContent = '今日额度已用满。';
    return;
  }
  const r = await send(TAB.id, { type: 'start' });
  if (r && r.ok) {
    $('status').textContent = '已开始。请留在该页面，不要切走。';
    setTimeout(refresh, 600);
  } else {
    $('status').textContent = '无法启动，请刷新 BOSS 页面后重试。';
  }
});

$('btn-stop').addEventListener('click', async () => {
  if (!TAB) return;
  await send(TAB.id, { type: 'stop' });
  $('status').textContent = '已请求停止，正在收尾…';
  setTimeout(refresh, 900);
});

$('btn-refresh').addEventListener('click', async () => {
  if (!TAB) {
    $('status').textContent = '先打开 BOSS 岗位列表页。';
    return;
  }
  $('status').textContent = '换一批：滚动加载 / 加载更多 / 下一页 / 最新排序…';
  $('btn-refresh').disabled = true;
  const r = await send(TAB.id, { type: 'refresh' });
  let msg;
  if (r && r.navigate) {
    msg = `${r.how || '已换条件'}，正在重新搜索，加载后会自动扫描一遍。`;
  } else if (r && r.reloaded) {
    msg = '页面正在刷新，刷新后会自动重新扫描一遍。';
  } else if (r && r.ok) {
    msg = `换一批完成（${r.how || '新岗位'}）：新增 ${r.added} 个，共 ${r.cards} 个，推荐 ${r.hit} 个。`;
  } else {
    msg = '没换到新岗位，面板日志里有具体原因与建议。';
  }
  $('btn-refresh').disabled = false;
  await refresh();
  $('status').textContent = msg;   // refresh 会重绘状态栏，结果文案要放在它之后
});

$('btn-report').addEventListener('click', async () => {
  if (!TAB) {
    $('status').textContent = '先打开 BOSS 岗位列表页。';
    return;
  }
  const r = await send(TAB.id, { type: 'report' });
  if (!r || !r.ok) {
    $('status').textContent = '取报告失败，请刷新 BOSS 页面后重试。';
    return;
  }
  $('rep-title').textContent = '扫描报告';
  $('rep-tip').textContent = '已全选，Ctrl+C 复制。报告含每个岗位的分数、结论与命中理由。';
  const box = $('rep');
  $('rep-text').value = r.text;
  box.hidden = false;
  if (!r.total) $('status').textContent = '0 个岗位，原因见报告最后一行。';
  const ta = $('rep-text');
  ta.focus();
  ta.setSelectionRange(0, ta.value.length);
});

/* 页面诊断：把 DOM 结构原样导出。选择器猜错时，这一份比任何截图都有用 */
$('btn-probe').addEventListener('click', async () => {
  if (!TAB) {
    $('status').textContent = '先打开 BOSS 岗位列表页。';
    return;
  }
  const r = await send(TAB.id, { type: 'probe' });
  if (!r || !r.ok) {
    $('status').textContent = '诊断失败，请刷新 BOSS 页面后重试（扩展需 1.4.0）。';
    return;
  }
  $('rep-title').textContent = '页面诊断';
  $('rep-tip').textContent = '已全选，Ctrl+C 复制发给开发者。里面有卡片结构、分页控件、详情区和按钮的真实 DOM。';
  $('rep-text').value = r.text;
  $('rep').hidden = false;
  $('status').textContent = '页面诊断已生成。在列表页和点开岗位后各导出一份，对比最有用。';
  const ta = $('rep-text');
  ta.focus();
  ta.setSelectionRange(0, ta.value.length);
});

$('rep-x').addEventListener('click', () => { $('rep').hidden = true; });

$('btn-open').addEventListener('click', () => {
  chrome.tabs.create({ url: 'https://www.zhipin.com/web/geek/jobs' });
  window.close();
});

$('btn-opt').addEventListener('click', () => {
  chrome.runtime.openOptionsPage();
  window.close();
});

refresh();

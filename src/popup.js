/* popup：只做展示与转发，不持有业务逻辑。
 * joblens 是只读的岗位筛选工具：这里不存在任何「开始 / 停止投递」的入口，
 * 也不会向页面发出点击或输入指令。
 */
'use strict';

const C = window.BossCore || {};
const DEFAULTS = (C && C.DEFAULTS) || {
  limits: { scroll_rounds: 8, max_cards: 120, panel_wait_ms: 3000 },
  safety: { auto_start: false },
  scoring: {}
};

const $ = (id) => document.getElementById(id);

function getStore(keys) {
  return new Promise((res) => chrome.storage.local.get(keys, (v) => res(v || {})));
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

function paint(state) {
  const cards = state ? (state.cards || 0) : 0;
  const hit = state ? (state.hit || 0) : 0;
  const skip = state ? (state.skip || 0) : 0;

  $('s-cards').textContent = cards;
  $('s-hit').textContent = hit;
  $('s-skip').textContent = skip;

  const dot = $('dot');
  if (!state) {
    dot.className = 'dot';
    $('site').textContent = '未在 BOSS 页面';
  } else {
    dot.className = 'dot on';
    $('site').textContent = '已连接';
  }

  $('btn-scan').disabled = !state;
  $('btn-refresh').disabled = !state;
  if (!state) $('rep').hidden = true;

  if (state) {
    $('status').textContent = cards
      ? `已扫描 ${cards} 个岗位：推荐 ${hit} 个，跳过 ${skip} 个。点开卡片自己判断，扩展不做任何点击。`
      : '点「扫描打分」先看匹配结果，扫描过程不点击任何岗位。';
  } else {
    $('status').textContent = '打开 BOSS 直聘岗位列表页（/web/geek/jobs）后使用。';
  }
}

async function refresh() {
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
    $('status').textContent = '诊断失败，请刷新 BOSS 页面后重试。';
    return;
  }
  $('rep-title').textContent = '页面诊断';
  $('rep-tip').textContent = '已全选，Ctrl+C 复制发给开发者。里面有卡片结构、分页控件与详情区的真实 DOM。';
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

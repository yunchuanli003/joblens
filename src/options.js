/* options：表单读写 + 校验，不参与页面操作。
 * 只保留与「筛选」有关的设置：求职画像、打分阈值、扫描上限、字体映射。
 * 投递节奏、招呼语模板、日限额这些参数随 v2.0 的只读化一并移除。
 */
'use strict';

const C = window.BossCore;
const $ = (id) => document.getElementById(id);

/* 表单 → 存储路径映射。kind: text(默认) / num / list / bool */
const MAP = {
  'p-role': { src: 'profile', path: 'role_summary' },
  'p-exp': { src: 'profile', path: 'experience' },
  'p-minsal': { src: 'profile', path: 'min_salary_k', kind: 'num' },
  'p-idle': { src: 'profile', path: 'activity_max_idle_days', kind: 'num' },
  'p-cities': { src: 'profile', path: 'target_cities', kind: 'list' },
  'p-prefer': { src: 'profile', path: 'prefer', kind: 'list' },
  'p-core': { src: 'profile', path: 'title_core', kind: 'list' },
  'p-avoid': { src: 'profile', path: 'avoid', kind: 'list' },
  'p-must': { src: 'profile', path: 'must_have', kind: 'list' },
  'p-rejectkw': { src: 'profile', path: 'reject_keywords', kind: 'list' },

  'l-max': { src: 'config', path: 'limits.max_cards', kind: 'num' },
  'l-scroll': { src: 'config', path: 'limits.scroll_rounds', kind: 'num' },

  's-approve': { src: 'config', path: 'scoring.approve_threshold', kind: 'num' },
  's-review': { src: 'config', path: 'scoring.review_threshold', kind: 'num' },
  's-rejectkw': { src: 'config', path: 'scoring.reject_keywords', kind: 'list' },

  'sf-autostart': { src: 'config', path: 'safety.auto_start', kind: 'bool' },

  'adv-pua': { src: 'config', path: 'puaMap' }
};

const LIST_IDS = Object.keys(MAP).filter((id) => MAP[id].kind === 'list');

/* 输入框 → chips 容器 id 的显式映射。
   不要用字符串拼接推导：'s-rejectkw' 去掉前缀后同样是 'rejectkw'，
   会和 'p-rejectkw' 撞到同一个容器，导致全局默认词显示在个人字段下面。 */
const CHIP_TARGET = {
  'p-cities': 'chips-cities',
  'p-prefer': 'chips-prefer',
  'p-core': 'chips-core',
  'p-avoid': 'chips-avoid',
  'p-must': 'chips-must',
  'p-rejectkw': 'chips-rejectkw',
  's-rejectkw': 'chips-srejectkw'
};
const CHIP_STYLE = {
  'p-prefer': 'hot', 'p-cities': 'hot', 'p-core': 'hot',
  'p-avoid': 'bad', 'p-rejectkw': 'bad', 's-rejectkw': 'bad'
};

let LOADED = { config: null, profile: null };
let dirty = false;

/* ---------------------------------------------------------------- 路径存取 */

function getPath(obj, path) {
  return path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
}

function setPath(obj, path, val) {
  const parts = path.split('.');
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    if (!cur[parts[i]] || typeof cur[parts[i]] !== 'object') cur[parts[i]] = {};
    cur = cur[parts[i]];
  }
  cur[parts[parts.length - 1]] = val;
}

/* ---------------------------------------------------------------- 列表解析 */

function parseList(s) {
  return String(s || '')
    .split(/[,，、;；\n\r]+/)
    .map((x) => x.trim())
    .filter(Boolean);
}

function renderChips(inputId) {
  const holder = document.getElementById(CHIP_TARGET[inputId] || '');
  if (!holder) return;
  const items = parseList($(inputId).value);
  const cls = CHIP_STYLE[inputId] || '';
  holder.innerHTML = items
    .map((t) => `<i class="${cls}">${escapeHtml(t)}</i>`)
    .join('');
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/* ---------------------------------------------------------------- 表单填充 */

function fill() {
  Object.keys(MAP).forEach((id) => {
    const m = MAP[id];
    const el = $(id);
    if (!el) return;
    const v = getPath(m.src === 'config' ? LOADED.config : LOADED.profile, m.path);
    if (m.kind === 'bool') el.checked = !!v;
    else if (m.kind === 'list') el.value = (v || []).join(', ');
    else el.value = (v === undefined || v === null) ? '' : v;
  });
  LIST_IDS.forEach(renderChips);
}

function collect() {
  const out = { config: {}, profile: {} };
  Object.keys(MAP).forEach((id) => {
    const m = MAP[id];
    const el = $(id);
    if (!el) return;
    const dst = m.src === 'config' ? out.config : out.profile;
    let v;
    if (m.kind === 'bool') v = el.checked;
    else if (m.kind === 'list') v = parseList(el.value);
    else if (m.kind === 'num') {
      const n = Number(el.value);
      v = Number.isFinite(n) ? n : 0;
    } else v = String(el.value || '').trim();
    setPath(dst, m.path, v);
  });
  return out;
}

/* ---------------------------------------------------------------- 校验 */

function validate(cfg) {
  const e = [];
  const L = cfg.limits, S = cfg.scoring;
  if (!(L.max_cards >= 10)) e.push('单次扫描上限至少 10 个');
  if (L.scroll_rounds < 1) e.push('扫描滚动轮数至少 1 轮');
  if (S.review_threshold > S.approve_threshold) e.push('待看阈值不能大于推荐阈值');
  if (!/^\d{10}$/.test(String(cfg.puaMap || ''))) e.push('字体映射必须是 0-9 组成的 10 位数字');
  return e;
}

/* ---------------------------------------------------------------- 提示 */

let toastTimer = null;
function toast(msg, ms = 2200) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), ms);
}

function markDirty(on) {
  dirty = on;
  const s = $('save-state');
  s.className = 'state' + (on ? ' dirty' : ' saved');
  s.textContent = on ? '未保存' : '已保存';
}

/* ---------------------------------------------------------------- 保存 */

async function save() {
  const got = collect();
  const cfg = C.deepMerge(LOADED.config, got.config);
  const profile = C.deepMerge(LOADED.profile, got.profile);

  const errs = validate(cfg);
  if (errs.length) {
    toast('⚠ ' + errs.join('；'), 4200);
    return;
  }

  await new Promise((res) => chrome.storage.local.set({ config: cfg, profile }, res));
  LOADED = { config: cfg, profile };

  // 通知已打开的 BOSS 页面立即生效
  try {
    const tabs = await new Promise((res) => chrome.tabs.query({ url: 'https://www.zhipin.com/*' }, res));
    (tabs || []).forEach((t) => {
      if (t.id != null) chrome.tabs.sendMessage(t.id, { type: 'reload' }, () => void chrome.runtime.lastError);
    });
  } catch (e) { /* 无 BOSS 页面时忽略 */ }

  markDirty(false);
  /* 标题核心词是最容易被漏掉、又最影响判定的一项：空着的时候「口腔医助」
     这类岗位也会拿到 30 分。保存成功但提醒一句，别让人以为配好了。 */
  const cores = (profile.title_core || []).filter(Boolean);
  if (!cores.length) toast('已保存 · 标题核心词为空，标题级误判挡不住', 4600);
  else toast('已保存');
}

/* ---------------------------------------------------------------- 绑定 */

async function boot() {
  const v = await new Promise((res) => chrome.storage.local.get(['config', 'profile'], (x) => res(x || {})));
  LOADED.config = C.deepMerge(C.DEFAULTS, v.config || {});
  LOADED.profile = C.deepMerge(C.PROFILE_TEMPLATE, v.profile || {});
  fill();
}

Object.keys(MAP).forEach((id) => {
  const el = $(id);
  if (!el) return;
  const ev = (el.tagName === 'TEXTAREA' || el.type === 'text' || el.type === 'number') ? 'input' : 'change';
  el.addEventListener(ev, () => {
    markDirty(true);
    if (MAP[id].kind === 'list') renderChips(id);
  });
});

$('btn-save').addEventListener('click', save);

document.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key === 's') {
    e.preventDefault();
    save();
  }
});

window.addEventListener('beforeunload', (e) => {
  if (!dirty) return;
  e.preventDefault();
  e.returnValue = '';
});

boot();

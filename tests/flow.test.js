/* content.js 流程测试：node tests/flow.test.js
 *
 * 在 jsdom 里加载 core + extract + content，mock chrome API，
 * 模拟一次「扫描 → 打分标注 → 投递 1 份 → 落库」的完整链路。
 * 这是唯一能验证 content.js 内部流程的手段，不需要任何真实站点或账号。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

let pass = 0, fail = 0;
const fails = [];

function ok(name, cond, detail) {
  if (cond) pass++;
  else { fail++; fails.push(name + (detail ? '\n   ' + detail : '')); }
}
function eq(name, a, b) {
  const A = JSON.stringify(a), B = JSON.stringify(b);
  if (A === B) pass++;
  else { fail++; fails.push(`${name}\n   期望 ${B}\n   实际 ${A}`); }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pua = (s) => s.split('').map((d) => String.fromCharCode(0xE031 + Number(d))).join('');

const SRC = path.join(__dirname, '..', 'src');
const read = (f) => fs.readFileSync(path.join(SRC, f), 'utf8');

/* ---------------------------------------------------------------- 页面结构 */

function pageHtml() {
  return `<!DOCTYPE html><html><head><title>BOSS直聘</title></head><body>
  <div class="job-list-box"><ul>
    <li class="job-card-wrapper">
      <div class="job-card-wrap" id="card-good">
        <a href="/job_detail/good001.html">
          <span class="job-name">产品运营</span>
          <span class="job-salary">${pua('18')}-${pua('28')}K</span>
          <h3 class="company-name">甲科技有限公司</h3>
          <span class="job-area">杭州·西湖区</span>
          <ul class="tag-list"><li>SaaS</li><li>数据驱动</li></ul>
        </a>
      </div>
    </li>
    <li class="job-card-wrapper">
      <div class="job-card-wrap" id="card-bad">
        <a href="/job_detail/bad002.html">
          <span class="job-name">保险销售顾问</span>
          <span class="job-salary">${pua('10')}-${pua('20')}K</span>
          <h3 class="company-name">乙保险公司</h3>
          <span class="job-area">杭州·上城区</span>
        </a>
      </div>
    </li>
  </ul></div>
  <div class="job-detail-box" id="panel"><div class="job-sec-text">请从左侧选择一个岗位查看详情</div></div>
  </body></html>`;
}

const PROFILE = {
  role_summary: '产品运营',
  target_cities: ['杭州'],
  min_salary_k: 10,
  experience: '3 年',
  prefer: ['产品运营', 'SaaS', '数据驱动'],
  avoid: ['电销'],
  must_have: [],
  reject_keywords: [],
  greeting_template: ''
};

const CONFIG = {
  limits: { session_apply_max: 2, daily_apply_max: 5, scroll_rounds: 1, max_cards: 2, panel_wait_ms: 2000 },
  pacing: {
    delay_min_sec: 0, delay_max_sec: 0, rest_every: 0, rest_min_sec: 0, rest_max_sec: 0,
    jitter_ratio: 0, read_jd_min_sec: 0, read_jd_max_sec: 0
  },
  safety: { consecutive_failure_limit: 3, read_jd_before_approve: true, manual_confirm: false },
  scoring: {
    approve_threshold: 62, review_threshold: 42,
    reject_keywords: ['保险', '贷款', '中介']
  },
  puaMap: '0123456789'
};

/* 分页场景用的卡片片段：jobId 决定去重键，所以每页必须不同 */
function cardHtml(id, title, salary) {
  return `<li class="job-card-wrapper">
      <div class="job-card-wrap" id="card-${id}">
        <a href="/job_detail/${id}.html">
          <span class="job-name">${title}</span>
          <span class="job-salary">${salary}</span>
          <h3 class="company-name">丙电子科技</h3>
          <span class="job-area">杭州·西湖区</span>
          <ul class="tag-list"><li>SaaS</li></ul>
        </a>
      </div>
    </li>`;
}

function pageHtmlPaged() {
  return `<!DOCTYPE html><html><head><title>BOSS直聘</title></head><body>
  <div class="job-list-box"><ul id="list">
    ${cardHtml('p1', '产品运营', '15-25K')}
    ${cardHtml('p2', '运营专员', '10-16K')}
  </ul></div>
  <div class="pagination"><a class="page-prev">上一页</a><a class="page-next" id="next">下一页</a></div>
  <div class="job-detail-box" id="panel"><div class="job-sec-text">请从左侧选择一个岗位查看详情</div></div>
  </body></html>`;
}

/* ---------------------------------------------------------------- 环境 */

const DEFAULT_URL = 'https://www.zhipin.com/web/geek/jobs?query=%E4%BA%A7%E5%93%81%E8%BF%90%E8%90%A5';

function boot(opts) {
  opts = opts || {};
  const dom = new JSDOM(opts.html || pageHtml(), {
    url: opts.url || DEFAULT_URL,
    runScripts: 'outside-only',
    pretendToBeVisual: true
  });
  const w = dom.window;

  // jsdom 不做布局：给固定尺寸，并让 .hidden 元素尺寸为 0
  w.Element.prototype.getBoundingClientRect = function () {
    if (this.classList && this.classList.contains('hidden')) {
      return { width: 0, height: 0, top: 0, left: 0, right: 0, bottom: 0, x: 0, y: 0 };
    }
    return { width: 340, height: 140, top: 20, left: 20, right: 360, bottom: 160, x: 20, y: 20 };
  };
  w.Element.prototype.scrollIntoView = function () { };
  const scrolls = { n: 0 };
  w.scrollBy = () => { scrolls.n++; };
  w.scrollTo = () => { };

  /* 详情页请求：默认 jsdom 没有 fetch，用例传 opts.fetchJd 才会打开这条路 */
  if (opts.fetchJd) {
    w.fetch = (url) => Promise.resolve({
      ok: true,
      status: 200,
      text: () => Promise.resolve(opts.fetchJd(url))
    });
  }

  /* 滚动模拟：BOSS 列表是无限滚动，滚到底会 append 新卡片。
     jsdom 的 scrollHeight/scrollTop 恒为 0，这里装成可滚动的容器。 */
  const listBox = w.document.querySelector('.job-list-box');
  if (listBox && opts.onScrollBottom) {
    Object.defineProperty(listBox, 'scrollHeight', { configurable: true, get: () => 4000 });
    Object.defineProperty(listBox, 'clientHeight', { configurable: true, get: () => 800 });
    let top = 0;
    Object.defineProperty(listBox, 'scrollTop', {
      configurable: true,
      get: () => top,
      set(v) { top = v; if (v > 0) opts.onScrollBottom(w, listBox); }
    });
  }

  /* chrome API mock */
  const stored = Object.assign(
    { config: CONFIG, profile: PROFILE, records: {}, stats: { date: '', applied: 0 } },
    opts.stored || {}
  );
  const handlers = [];

  w.chrome = {
    storage: {
      local: {
        get(keys, cb) {
          const out = {};
          const list = keys == null ? Object.keys(stored) : (Array.isArray(keys) ? keys : [keys]);
          list.forEach((k) => { if (stored[k] !== undefined) out[k] = JSON.parse(JSON.stringify(stored[k])); });
          cb(out);
        },
        set(obj, cb) {
          Object.keys(obj).forEach((k) => { stored[k] = JSON.parse(JSON.stringify(obj[k])); });
          if (cb) cb();
        },
        remove(keys, cb) {
          const list = Array.isArray(keys) ? keys : [keys];
          list.forEach((k) => { delete stored[k]; });
          if (cb) cb();
        }
      }
    },
    runtime: {
      onMessage: { addListener(fn) { handlers.push(fn); } },
      sendMessage() { },
      openOptionsPage() { }
    }
  };

  // 记录卡片点击次数，用于验证「只点该点的」
  const clicks = { good: 0, bad: 0, chat: 0 };
  const goodCard = w.document.getElementById('card-good');
  const badCard = w.document.getElementById('card-bad');
  const panel = w.document.getElementById('panel');

  /* 点开卡片 → 右侧面板出现 JD 与「沟通」按钮。默认只绑 card-good，
     用例可以用 opts.cardIds 指定别的卡片（多卡场景要每张都能点开）。 */
  function bindCard(el, sel) {
    if (!el) return;
    var host = el;
    /* sel 用来模拟「点击处理不在容器上」的版本：只有点卡片里的 a / 标题才有反应 */
    if (sel) { try { host = el.querySelector(sel) || el; } catch (e) { host = el; } }
    host.addEventListener('click', () => {
      clicks.good++;
      /* 带上卡片 id：两个岗位的 JD 文本必须不同，否则「面板变了没」判断不出来 */
      panel.innerHTML = '<div class="job-sec-text">产品运营 岗位职责：负责 B 端 SaaS 产品的用户增长与数据运营，' +
        '要求 3 年以上经验，熟悉数据分析工具。任职要求：本科及以上。' + (el.id || '') + '</div>' +
        '<a class="btn btn-startchat">' + (opts.panelBtn || '立即沟通') + '</a>';
      panel.querySelector('.btn-startchat').addEventListener('click', () => {
        clicks.chat++;
        if (opts.onGreetingDialog) { opts.onGreetingDialog(w, dom); return; }
        if (opts.onChat) { opts.onChat(w, dom); return; }   // 模拟「跳进聊天页」的版本
        const dlg = w.document.createElement('div');
        dlg.className = 'dialog-wrap';
        dlg.innerHTML = '<div class="dialog-con">该 Boss 正在与您沟通，是否继续沟通？</div>' +
          '<a class="btn-continue">继续沟通</a>';
        w.document.body.appendChild(dlg);
        dlg.querySelector('.btn-continue').addEventListener('click', () => dlg.remove());
      });
    });
  }
  bindCard(w.document.getElementById('card-good'));
  (opts.cardIds || []).forEach(function (id) {
    bindCard(w.document.getElementById('card-' + id), opts.cardSelector);
  });

  if (badCard) badCard.addEventListener('click', () => { clicks.bad++; });

  /* 分页按钮的点击行为由用例决定：不同场景要验证的结果不同 */
  const nextEl = w.document.getElementById('next');
  if (nextEl && opts.onNext) nextEl.addEventListener('click', () => opts.onNext(w));

  const code = [read('core.js'), read('extract.js'), read('content.js')].join('\n;\n');
  w.eval(code);

  return { dom, w, stored, handlers, clicks, scrolls };
}

function send(handlers, msg) {
  return new Promise((resolve) => {
    let done = false;
    const reply = (r) => { if (!done) { done = true; resolve(r); } };
    handlers[0](msg, {}, reply);
    setTimeout(() => reply(null), 12000);
  });
}

/* ---------------------------------------------------------------- 用例 */

(async function run() {
  console.log('== content.js 全链路 ==');

  const env = boot();
  const { w, stored, handlers, clicks } = env;
  await sleep(150);   // 等 boot() 里的异步初始化完成

  ok('注入悬浮面板', !!w.document.getElementById('boss-scout-host'));

  const pong = await send(handlers, { type: 'ping' });
  ok('ping 有响应', pong && pong.ok, JSON.stringify(pong));
  eq('初始未运行', pong && pong.running, false);

  /* ---- 扫描 ---- */
  const scanned = await send(handlers, { type: 'scan' });
  ok('扫描成功', scanned && scanned.ok, JSON.stringify(scanned));
  eq('扫描到 2 个岗位', scanned && scanned.cards, 2);
  eq('推荐 1 个', scanned && scanned.hit, 1);

  const badges = w.document.querySelectorAll('.bs-badge');
  eq('每张卡都有徽章', badges.length, 2);

  const goodBadge = w.document.querySelector('#card-good .bs-badge');
  const badBadge = w.document.querySelector('#card-bad .bs-badge');
  eq('高分卡标记为 approve', goodBadge && goodBadge.dataset.v, 'approve');
  eq('保险岗标记为 reject', badBadge && badBadge.dataset.v, 'reject');
  ok('徽章显示分数', /^\d+/.test(goodBadge.textContent), goodBadge.textContent);
  eq('扫描过程不点击任何岗位', clicks.good + clicks.bad, 0);

  /* ---- 扫描报告 ---- */
  const shadow = w.document.getElementById('boss-scout-host').shadowRoot;
  const reportBox = shadow.getElementById('report');
  const reportText = () => shadow.getElementById('r-text').value;

  eq('报告初始隐藏', reportBox.hidden, true);
  shadow.getElementById('btn-report').click();
  await sleep(60);

  eq('点报告后打开', reportBox.hidden, false);
  const rt = reportText();
  ok('报告含标题与汇总', rt.indexOf('# boss-scout 扫描报告') === 0 && rt.indexOf('卡片 2｜推荐 1') > 0, rt);
  ok('报告含推荐岗位', rt.indexOf('## 推荐 (1)') > 0 && rt.indexOf('产品运营') > 0, rt);
  ok('报告含跳过岗位', rt.indexOf('## 跳过 (1)') > 0 && rt.indexOf('保险销售顾问') > 0, rt);
  ok('报告带判定理由', rt.indexOf('↳ ') > 0, rt);

  shadow.getElementById('r-close').click();
  await sleep(30);
  eq('关闭后隐藏', reportBox.hidden, true);

  /* ---- 投递 ---- */
  const started = await send(handlers, { type: 'start' });
  ok('启动投递', started && started.ok);

  // 等一轮投递跑完（session_max=1）
  for (let i = 0; i < 60 && !stored.records.id_placeholder; i++) {
    await sleep(200);
    if (Object.keys(stored.records).length > 0) break;
  }
  await sleep(600);

  const keys = Object.keys(stored.records);
  eq('只记录了 1 个岗位', keys.length, 1);
  ok('记录的是高分岗位', keys[0] === 'id:good001', keys.join(','));
  eq('状态为 applied', stored.records['id:good001'] && stored.records['id:good001'].status, 'applied');
  eq('今日计数 +1', stored.stats.applied, 1);
  eq('只点了高分岗位', clicks.good, 1);
  eq('没有点保险岗', clicks.bad, 0);

  /* ---- 停止后状态 ---- */
  const pong2 = await send(handlers, { type: 'ping' });
  eq('投递结束回到空闲', pong2 && pong2.running, false);
  eq('本轮计数为 1', pong2 && pong2.applied, 1);

  const goodBadgeAfter = w.document.querySelector('#card-good .bs-badge');
  eq('投递后徽章变为已投', goodBadgeAfter && goodBadgeAfter.dataset.v, 'done');

  /* ---- 跨轮去重：同岗位不重复投 ---- */
  const started2 = await send(handlers, { type: 'start' });
  ok('可再次启动', started2 && started2.ok);
  await sleep(1500);
  eq('已投岗位不会被重复投递', stored.stats.applied, 1);
  eq('今日计数未被累加', clicks.good, 1);

  /* ---- 不在列表页：不滚动、不误报「选择器坏了」 ---- */
  console.log('== 不在岗位列表页 ==');
  const chat = boot({
    url: 'https://www.zhipin.com/web/geek/chat?id=7f8a9&securityId=b2c3d4',
    html: '<!DOCTYPE html><html><head><title>BOSS直聘</title></head><body><div class="chat">与 Boss 沟通中</div></body></html>'
  });
  await sleep(160);

  const s2 = await send(chat.handlers, { type: 'scan' });
  ok('聊天页扫描返回 0 且不报错', s2 && s2.ok && s2.cards === 0, JSON.stringify(s2));
  eq('聊天页不滚动页面', chat.scrolls.n, 0);

  const chatShadow = chat.w.document.getElementById('boss-scout-host').shadowRoot;
  const chatLog = chatShadow.getElementById('log').textContent;
  ok('日志说明当前是聊天页', chatLog.indexOf('聊天页') >= 0, chatLog);

  /* 回归：聊天页 URL 带 securityId 时不能报「安全校验」，否则一轮投递被无故中断 */
  ok('聊天页不被判为安全校验', chatLog.indexOf('安全校验') < 0, chatLog);

  const chatRep = await send(chat.handlers, { type: 'report' });
  ok('报告带页面诊断', chatRep && chatRep.text.indexOf('不是岗位列表页') >= 0, chatRep && chatRep.text);

  /* ---- 自我跳转不掐断整轮：点开沟通后跳进聊天页属于预期 ---- */
  console.log('== 自我跳转 ==');
  /* 用 onChat 真实模拟「跳进聊天页 + 聊天页 DOM 渲染」。只改 URL 不换 DOM，
     测的是假场景：脚本找不到输入框，自然会判失败。 */
  const nav = boot({
    onChat: (w, dom) => {
      dom.reconfigure({ url: 'https://www.zhipin.com/web/geek/chat?id=1&securityId=2' });
      const box = w.document.createElement('div');
      box.className = 'chat-box';
      box.innerHTML = '<div class="message-list" id="msgs"></div>' +
        '<div class="chat-input" id="input" contenteditable="true"></div>' +
        '<button class="btn-send" id="send">发送</button>';
      w.document.body.appendChild(box);
      const input = box.querySelector('#input');
      box.querySelector('#send').addEventListener('click', () => {
        const t = String(input.textContent || '').trim();
        if (!t) return;
        const m = w.document.createElement('div');
        m.className = 'chat-message';
        m.textContent = t;
        box.querySelector('#msgs').appendChild(m);
        input.textContent = '';
      });
    }
  });
  await sleep(160);
  await send(nav.handlers, { type: 'scan' });
  await send(nav.handlers, { type: 'start' });

  for (let i = 0; i < 120 && nav.stored.stats.applied === 0; i++) await sleep(100);

  const navShadow = nav.w.document.getElementById('boss-scout-host').shadowRoot;
  const navLog = navShadow.getElementById('log').textContent;
  ok('自我跳转不被当成用户切页', navLog.indexOf('页面已切换') < 0, navLog);
  ok('跳转后本轮仍完成投递', nav.stored.stats.applied === 1,
    'applied=' + nav.stored.stats.applied + '\n   ' + navLog);

  /* ---- 换一批：BOSS 是无限滚动，滚到底就该拿到新岗位 ---- */
  console.log('== 换一批（滚动加载） ==');
  let scrolled = 0;
  const sc = boot({
    onScrollBottom: (win, box) => {
      scrolled++;
      const ul = box.querySelector('ul');
      if (ul.querySelector('#card-s1')) return;
      ul.insertAdjacentHTML('beforeend', cardHtml('s1', '产品运营（新）', '20-28K'));
    }
  });
  await sleep(160);
  await send(sc.handlers, { type: 'scan' });
  const sr = await send(sc.handlers, { type: 'refresh' });
  ok('换一批首选滚动加载', sr && sr.ok && sr.how === '滚动加载', JSON.stringify(sr));
  ok('滚动后新增岗位', sr && sr.added >= 1, JSON.stringify(sr));
  ok('确实滚动了容器', scrolled > 0, String(scrolled));
  ok('日志写明是滚动加载', sc.w.document.getElementById('boss-scout-host').shadowRoot
    .getElementById('log').textContent.indexOf('滚动加载') >= 0);

  /* ---- 换一批：点「下一页」拿到新岗位 ---- */
  console.log('== 换一批 ==');
  const pg = boot({
    html: pageHtmlPaged(),
    onNext: (win) => {
      win.document.getElementById('list').innerHTML =
        cardHtml('p3', '产品运营（B端增长）', '20-30K') +
        cardHtml('p4', '用户运营专员', '12-18K');
      const n = win.document.getElementById('next');
      if (n) n.remove();          // 到底了，下一页链接消失
    }
  });
  await sleep(160);

  const pgShadow = pg.w.document.getElementById('boss-scout-host').shadowRoot;
  const pgLog = () => pgShadow.getElementById('log').textContent;

  const rr = await send(pg.handlers, { type: 'refresh' });
  ok('换一批成功', rr && rr.ok, JSON.stringify(rr));
  eq('新增 2 个岗位', rr && rr.added, 2);
  eq('卡片数同步为 2（旧页断开即剔除）', rr && rr.cards, 2);
  ok('日志写明换了什么', pgLog().indexOf('换一批完成') >= 0, pgLog());
  eq('新页每张卡都有徽章', pg.w.document.querySelectorAll('.bs-badge').length, 2);

  /* 回归：分页会改 URL，1.5 秒后的跳转监听不能把刚拿到的卡片清空 */
  pg.dom.reconfigure({ url: 'https://www.zhipin.com/web/geek/jobs?query=x&page=2' });
  await sleep(1900);
  const pgPing = await send(pg.handlers, { type: 'ping' });
  eq('换页后的 URL 变化不清空卡片', pgPing && pgPing.cards, 2);

  const pgRep = await send(pg.handlers, { type: 'report' });
  ok('报告已换成新一页', pgRep && pgRep.text.indexOf('产品运营（B端增长）') > 0, pgRep && pgRep.text);
  ok('报告只统计新一页的 2 个岗位', pgRep && /卡片 2｜/.test(pgRep.text), pgRep && pgRep.text);

  /* ---- 换一批：控件在但点了没反应，不能假装成功 ---- */
  const dead = boot({ html: pageHtmlPaged(), onNext: () => { } });
  await sleep(160);
  await send(dead.handlers, { type: 'scan' });       // 先有一批卡片，才谈得上「换」
  const deadShadow = dead.w.document.getElementById('boss-scout-host').shadowRoot;
  const deadLog = () => deadShadow.getElementById('log').textContent;

  const pending = send(dead.handlers, { type: 'refresh' });
  for (let i = 0; i < 40 && deadShadow.getElementById('confirm').hidden; i++) await sleep(150);
  const confirmShown = !deadShadow.getElementById('confirm').hidden;
  if (confirmShown) deadShadow.getElementById('c-no').click();   // 选择「不刷新」
  const dr = await pending;

  ok('翻到底时先弹确认再决定是否刷新', confirmShown);
  eq('点不动时判定失败，不算换成功', dr && dr.ok, false);
  ok('日志指出按钮没带来新岗位', deadLog().indexOf('没带来新岗位') >= 0, deadLog());
  ok('日志给出换词/换城市建议',
    deadLog().indexOf('换关键词') >= 0 && deadLog().indexOf('换城市') >= 0, deadLog());
  eq('取消刷新后卡片仍在', (await send(dead.handlers, { type: 'ping' })).cards, 2);

  /* ---- 回归：卡片里的「查看更多」不是翻页控件，点了会打开该岗位 ---- */
  const trap = boot({
    html: `<!DOCTYPE html><html><head><title>BOSS直聘</title></head><body>
    <div class="job-list-box"><ul>
      <li class="job-card-wrapper">
        <div class="job-card-wrap" id="card-good">
          <a href="/job_detail/p1.html">
            <span class="job-name">射频工程师</span>
            <span class="job-salary">8-11K</span>
            <span class="see-more">查看更多</span>
          </a>
        </div>
      </li>
    </ul></div>
    <div class="job-detail-box" id="panel"><div class="job-sec-text">请从左侧选择一个岗位查看详情</div></div>
    </body></html>`
  });
  await sleep(160);
  await send(trap.handlers, { type: 'scan' });

  const trapShadow = trap.w.document.getElementById('boss-scout-host').shadowRoot;
  const trapPending = send(trap.handlers, { type: 'refresh' });
  for (let i = 0; i < 30 && trapShadow.getElementById('confirm').hidden; i++) await sleep(150);
  if (!trapShadow.getElementById('confirm').hidden) trapShadow.getElementById('c-no').click();
  await trapPending;

  eq('绝不点卡片里的「查看更多」', trap.clicks.good, 0);

  /* ---- 换一批走整页重载：重载后要自己接着扫，否则用户以为没生效 ---- */
  const re = boot({
    stored: { pending_scan: { at: Date.now(), path: '/web/geek/jobs?query=x' } }
  });
  await sleep(3200);        // 等 boot 里的 2.6s 延迟扫描
  const rePing = await send(re.handlers, { type: 'ping' });
  eq('刷新后自动补扫一遍', rePing && rePing.cards, 2);
  ok('一次性标记被消费掉', !re.stored.pending_scan, JSON.stringify(re.stored.pending_scan));

  /* ---- 聊天页：招呼语必须真的发出去，否则记成「已投」就是假账 ---- */
  console.log('== 聊天页发招呼语 ==');
  const CHAT_HTML = `
    <div class="chat-box">
      <div class="message-list" id="msgs"></div>
      <div class="chat-input" id="input" contenteditable="true"></div>
      <button class="btn-send" id="send">发送</button>
    </div>`;

  const chatEnv = boot({
    onChat: (w, dom) => {
      dom.reconfigure({ url: 'https://www.zhipin.com/web/geek/chat?id=1&securityId=2' });
      w.document.body.innerHTML = CHAT_HTML;
      const input = w.document.getElementById('input');
      w.document.getElementById('send').addEventListener('click', () => {
        const t = String(input.textContent || '').trim();
        if (!t) return;
        const m = w.document.createElement('div');
        m.className = 'chat-message';
        m.textContent = t;
        w.document.getElementById('msgs').appendChild(m);
        input.textContent = '';
      });
    }
  });
  await sleep(160);
  await send(chatEnv.handlers, { type: 'scan' });
  await send(chatEnv.handlers, { type: 'start' });

  for (let i = 0; i < 120 && Object.keys(chatEnv.stored.records).length === 0; i++) await sleep(100);
  const chatRec = chatEnv.stored.records['id:good001'];
  ok('聊天页发出招呼语后记为已投', chatRec && chatRec.status === 'applied', JSON.stringify(chatRec));

  const sentMsg = chatEnv.w.document.querySelector('#msgs .chat-message');
  ok('消息列表出现发给 Boss 的内容', !!sentMsg && sentMsg.textContent.length > 4,
    sentMsg && sentMsg.textContent);

  const sendLog = chatEnv.w.document.getElementById('boss-scout-host').shadowRoot
    .getElementById('log').textContent;
  ok('日志写明已发送招呼语', sendLog.indexOf('已发送招呼语') >= 0, sendLog);
  eq('今日计数只加 1', chatEnv.stored.stats.applied, 1);

  /* ---- 聊天页没有输入框：不能假装成功 ---- */
  const noInput = boot({
    onChat: (w, dom) => {
      dom.reconfigure({ url: 'https://www.zhipin.com/web/geek/chat?id=9' });
      w.document.body.innerHTML = '<div class="chat-box"><div class="tip">该 Boss 已关闭沟通</div></div>';
    }
  });
  await sleep(160);
  await send(noInput.handlers, { type: 'scan' });
  await send(noInput.handlers, { type: 'start' });

  for (let i = 0; i < 150 && Object.keys(noInput.stored.records).length === 0; i++) await sleep(100);
  const badRec = noInput.stored.records['id:good001'];
  ok('没发出去就不记已投', badRec && badRec.status === 'greeting_failed', JSON.stringify(badRec));
  eq('没发出去不计入今日额度', noInput.stored.stats.applied, 0);

  /* ---- 聊天页没有发送按钮：必须能靠回车发出去 ---- */
  const enterChat = boot({
    onChat: (w, dom) => {
      dom.reconfigure({ url: 'https://www.zhipin.com/web/geek/chat?id=3' });
      w.document.body.innerHTML = `
        <div class="chat-box">
          <div class="message-list" id="msgs"></div>
          <div class="chat-input" id="input" contenteditable="true"></div>
        </div>`;
      const input = w.document.getElementById('input');
      input.addEventListener('keydown', (e) => {
        if (e.key !== 'Enter') return;
        const t = String(input.textContent || '').trim();
        if (!t) return;
        const m = w.document.createElement('div');
        m.className = 'chat-message';
        m.textContent = t;
        w.document.getElementById('msgs').appendChild(m);
        input.textContent = '';
      });
    }
  });
  await sleep(160);
  await send(enterChat.handlers, { type: 'scan' });
  await send(enterChat.handlers, { type: 'start' });

  for (let i = 0; i < 150 && Object.keys(enterChat.stored.records).length === 0; i++) await sleep(100);
  const enterRec = enterChat.stored.records['id:good001'];
  ok('没有发送按钮时用回车发出去', enterRec && enterRec.status === 'applied', JSON.stringify(enterRec));
  const enterMsg = enterChat.w.document.querySelector('#msgs .chat-message');
  ok('回车后消息真的出现在会话里', !!enterMsg && enterMsg.textContent.length > 4,
    enterMsg && enterMsg.textContent);
  const enterLog = enterChat.w.document.getElementById('boss-scout-host').shadowRoot
    .getElementById('log').textContent;
  ok('日志说明改走回车', enterLog.indexOf('改用回车') >= 0, enterLog);

  /* ---- 招呼语交给 BOSS：只把会话打开，绝不代发 ---- */
  console.log('== 招呼语交给 BOSS ==');
  const handCfg = Object.assign({}, CONFIG, {
    safety: Object.assign({}, CONFIG.safety, { handoff_greeting: true })
  });
  const hand = boot({
    stored: { config: handCfg },
    onChat: (w, dom) => {
      dom.reconfigure({ url: 'https://www.zhipin.com/web/geek/chat?id=9' });
      const box = w.document.createElement('div');
      box.className = 'chat-box';
      /* BOSS 已自动打招呼：会话里已经有一条它发的消息，输入框是空的 */
      box.innerHTML = '<div class="message-list" id="msgs">' +
        '<div class="chat-message" id="auto">你好，方便发一份简历吗？</div></div>' +
        '<div class="chat-input" id="input" contenteditable="true"></div>' +
        '<button class="btn-send" id="send">发送</button>';
      w.document.body.appendChild(box);
      const input = box.querySelector('#input');
      box.querySelector('#send').addEventListener('click', () => {
        const t = String(input.textContent || '').trim();
        if (!t) return;
        const m = w.document.createElement('div');
        m.className = 'chat-message';
        m.textContent = t;
        box.querySelector('#msgs').appendChild(m);
        input.textContent = '';
      });
    }
  });
  await sleep(160);
  await send(hand.handlers, { type: 'scan' });
  await send(hand.handlers, { type: 'start' });

  for (let i = 0; i < 150 && Object.keys(hand.stored.records).length === 0; i++) await sleep(100);
  const handRec = hand.stored.records['id:good001'];
  ok('交给 BOSS 时也记成已投', handRec && handRec.status === 'applied', JSON.stringify(handRec));
  eq('记录标明是 BOSS 发的', handRec && handRec.note, 'boss_auto');

  const handMsgs = hand.w.document.querySelectorAll('#msgs .chat-message');
  eq('扩展没有再发一条（对方的自动招呼保留原样）', handMsgs.length, 1);
  eq('输入框保持为空', String(hand.w.document.getElementById('input').textContent || ''), '');

  const handLog = hand.w.document.getElementById('boss-scout-host').shadowRoot
    .getElementById('log').textContent;
  ok('日志写明 BOSS 已自动打招呼', handLog.indexOf('BOSS 已自动打招呼') >= 0, handLog);
  ok('日志不出现「已发送招呼语」', handLog.indexOf('已发送招呼语') < 0, handLog);

  /* BOSS 没配自动打招呼：会话建立起来了，也要如实标注，不能装作发过 */
  const noMsg = boot({
    stored: { config: handCfg },
    onChat: (w, dom) => {
      dom.reconfigure({ url: 'https://www.zhipin.com/web/geek/chat?id=10' });
      const box = w.document.createElement('div');
      box.className = 'chat-box';
      box.innerHTML = '<div class="message-list" id="msgs"></div>' +
        '<div class="chat-input" id="input" contenteditable="true"></div>';
      w.document.body.appendChild(box);
    }
  });
  await sleep(160);
  await send(noMsg.handlers, { type: 'scan' });
  await send(noMsg.handlers, { type: 'start' });

  for (let i = 0; i < 150 && Object.keys(noMsg.stored.records).length === 0; i++) await sleep(100);
  const noMsgRec = noMsg.stored.records['id:good001'];
  eq('没看到自动消息时如实标注', noMsgRec && noMsgRec.note, 'boss_no_msg');
  eq('会话里没有被塞进任何消息', noMsg.w.document.querySelectorAll('#msgs .chat-message').length, 0);
  const noMsgLog = noMsg.w.document.getElementById('boss-scout-host').shadowRoot
    .getElementById('log').textContent;
  ok('日志提示招呼语交给 BOSS', noMsgLog.indexOf('招呼语交给 BOSS') >= 0, noMsgLog);

  /* BOSS 自己弹的打招呼框：预填的就是你在 BOSS 里写的招呼语，不能被覆盖 */
  console.log('== 打招呼弹窗不覆盖 ==');
  let dlgSent = null;
  const gd = boot({
    stored: { config: handCfg },
    onGreetingDialog: (w) => {
      const dlg = w.document.createElement('div');
      dlg.className = 'dialog-wrap';
      dlg.innerHTML = '<div class="dialog-con"><p>和 TA 打个招呼，发送招呼语后即可开始沟通</p>' +
        '<textarea id="gta">您好，我是做 EMC 硬件测试的，想了解一下这个岗位。</textarea></div>' +
        '<div class="dialog-footer"><a class="btn-sure">发送</a></div>';
      w.document.body.appendChild(dlg);
      dlg.querySelector('.btn-sure').addEventListener('click', () => {
        dlgSent = dlg.querySelector('#gta').value;
        dlg.remove();
      });
    }
  });
  await sleep(160);
  await send(gd.handlers, { type: 'scan' });
  await send(gd.handlers, { type: 'start' });

  for (let i = 0; i < 150 && !dlgSent; i++) await sleep(100);
  /* 点完发送到落库之间还有一段确认等待，别在这一瞬间就断言记录 */
  for (let i = 0; i < 150 && !gd.stored.records['id:good001']; i++) await sleep(100);
  eq('预填的招呼语原样发出', dlgSent, '您好，我是做 EMC 硬件测试的，想了解一下这个岗位。');
  ok('没有被替换成扩展模板', String(dlgSent || '').indexOf('看到贵司在招') < 0, String(dlgSent));
  const gdRec = gd.stored.records['id:good001'];
  eq('弹窗发出的这份也算已投', gdRec && gdRec.status, 'applied');

  /* ---- 已投过的岗位不该再走一遍：jobId 和记录键对不上时也要认得出来 ---- */
  console.log('== 已投去重 ==');
  const drift = boot({
    /* 记录是按「标题|公司」存的（当时卡片没有 job_detail 链接），
       这次卡片能取到 jobId —— 旧实现两套键对不上，会当成新岗位重投一遍 */
    stored: {
      records: {
        'tx:产品运营|甲科技有限公司': {
          status: 'applied', title: '产品运营', company: '甲科技有限公司'
        }
      }
    }
  });
  await sleep(160);
  await send(drift.handlers, { type: 'scan' });
  await send(drift.handlers, { type: 'start' });
  await sleep(600);

  eq('键漂移的已投岗位不进队列', drift.clicks.good, 0);
  eq('没有产生新投递', drift.stored.stats.applied, 0);
  ok('日志说明这批都投过', drift.w.document.getElementById('boss-scout-host').shadowRoot
    .getElementById('log').textContent.indexOf('都已投过') >= 0,
    drift.w.document.getElementById('boss-scout-host').shadowRoot.getElementById('log').textContent);

  /* BOSS 自己把按钮改成「继续沟通」= 之前联系过，别点第二遍 */
  const contacted = boot({ panelBtn: '继续沟通' });
  await sleep(160);
  await send(contacted.handlers, { type: 'scan' });
  await send(contacted.handlers, { type: 'start' });

  for (let i = 0; i < 120 && !contacted.stored.records['id:good001']; i++) await sleep(100);
  const ctRec = contacted.stored.records['id:good001'];
  eq('已沟通的岗位记成 already_contacted', ctRec && ctRec.status, 'already_contacted');
  eq('已沟通不占额度', contacted.stored.stats.applied, 0);
  eq('压根没点那个按钮', contacted.clicks.chat, 0);
  ok('日志写明已沟通过', contacted.w.document.getElementById('boss-scout-host').shadowRoot
    .getElementById('log').textContent.indexOf('已沟通过') >= 0,
    contacted.w.document.getElementById('boss-scout-host').shadowRoot.getElementById('log').textContent);

  /* ---- 同一岗位在列表里出现两张卡：一张带 job_detail 链接、一张不带，只算一个 ---- */
  console.log('== 重复卡片合并 ==');
  const dup = boot({
    html: `<!DOCTYPE html><html><head><title>BOSS直聘</title></head><body>
    <div class="job-list-box"><ul>
      <li class="job-card-wrapper"><div class="job-card-wrap">
        <a href="/job_detail/dup01.html">
          <span class="job-name">产品运营</span><span class="job-salary">15-25K</span>
          <h3 class="company-name">丙电子科技</h3><span class="job-area">杭州·西湖区</span>
          <ul class="tag-list"><li>SaaS</li></ul>
        </a>
      </div></li>
      <li class="job-card-wrapper"><div class="job-card-wrap">
        <span class="job-name">产品运营</span><span class="job-salary">15-25K</span>
        <h3 class="company-name">丙电子科技</h3><span class="job-area">杭州·西湖区</span>
        <ul class="tag-list"><li>SaaS</li></ul>
      </div></li>
    </ul></div>
    <div class="job-detail-box" id="panel"><div class="job-sec-text">请从左侧选择一个岗位查看详情</div></div>
    </body></html>`
  });
  await sleep(160);
  const dupRes = await send(dup.handlers, { type: 'scan' });
  eq('同一岗位两张卡只算一个', dupRes.cards, 1);

  /* 同一家公司两个同名岗位（jobId 不同）是两份工作，不能被合并掉 */
  const twin = boot({
    html: `<!DOCTYPE html><html><head><title>BOSS直聘</title></head><body>
    <div class="job-list-box"><ul>
      ${cardHtml('t1', '产品运营', '15-25K')}
      ${cardHtml('t2', '产品运营', '15-25K')}
    </ul></div>
    <div class="job-detail-box" id="panel"><div class="job-sec-text">请从左侧选择一个岗位查看详情</div></div>
    </body></html>`
  });
  await sleep(160);
  const twinRes = await send(twin.handlers, { type: 'scan' });
  eq('不同 jobId 的同名岗位各算一个', twinRes.cards, 2);

  /* ---- 投满本轮上限后，再点一次「开始投递」必须能接着投 ---- */
  console.log('== 本轮上限后继续 ==');
  const capCfg = Object.assign({}, CONFIG, {
    limits: Object.assign({}, CONFIG.limits, { session_apply_max: 1, max_cards: 5, panel_wait_ms: 6000 })
  });
  /* 用「打招呼弹窗」这条路径：它不跳页，两轮都能在同一份 DOM 上跑完，
     正好单独验证「本轮计数有没有归零」这一件事。 */
  const cap = boot({
    stored: { config: capCfg },
    cardIds: ['k1', 'k2'],
    html: `<!DOCTYPE html><html><head><title>BOSS直聘</title></head><body>
    <div class="job-list-box"><ul>
      ${cardHtml('k1', '产品运营', '15-25K')}
      ${cardHtml('k2', '产品运营', '15-25K')}
    </ul></div>
    <div class="job-detail-box" id="panel"><div class="job-sec-text">请从左侧选择一个岗位查看详情</div></div>
    </body></html>`,
    onGreetingDialog: (w) => {
      const dlg = w.document.createElement('div');
      dlg.className = 'dialog-wrap';
      dlg.innerHTML = '<div class="dialog-con"><p>和 TA 打个招呼</p>' +
        '<textarea id="gta"></textarea></div>' +
        '<div class="dialog-footer"><a class="btn-sure">发送</a></div>';
      w.document.body.appendChild(dlg);
      dlg.querySelector('.btn-sure').addEventListener('click', () => dlg.remove());
    }
  });
  await sleep(160);
  await send(cap.handlers, { type: 'scan' });
  await send(cap.handlers, { type: 'start' });

  const capShadow = () => cap.w.document.getElementById('boss-scout-host').shadowRoot;
  /* 看状态栏而不是日志：日志只留最近几行，「本轮结束」很容易被后续行挤掉 */
  for (let i = 0; i < 150 && capShadow().getElementById('status').textContent !== '完成'; i++) await sleep(100);
  eq('第一轮投满 1 份就停', Object.keys(cap.stored.records).length, 1);

  /* 关键回归：不刷新页面，直接再点一次。原来这里会立刻报「已达本轮上限」。 */
  await send(cap.handlers, { type: 'start' });
  for (let i = 0; i < 150 && Object.keys(cap.stored.records).length < 2; i++) await sleep(100);
  eq('再点一次能投第 2 份', Object.keys(cap.stored.records).length, 2);
  eq('两份都成功', Object.keys(cap.stored.records).filter((k) => cap.stored.records[k].status === 'applied').length, 2);

  const capLog = capShadow().getElementById('log').textContent;
  ok('没有卡在「已达本轮上限」', capLog.indexOf('已达本轮上限') < 0, capLog);

  /* ---- 点击处理不在卡片容器上：要能顺着标题/链接把面板点开 ---- */
  console.log('== 点开卡片的多个目标 ==');
  const chain = boot({
    cardIds: ['chain'],
    cardSelector: 'a',            // 模拟「点外层 div 完全没反应」的版本
    html: `<!DOCTYPE html><html><head><title>BOSS直聘</title></head><body>
    <div class="job-list-box"><ul>
      ${cardHtml('chain', '产品运营', '15-25K')}
    </ul></div>
    <div class="job-detail-box" id="panel"><div class="job-sec-text">请从左侧选择一个岗位查看详情</div></div>
    </body></html>`,
    onGreetingDialog: (w) => {
      const dlg = w.document.createElement('div');
      dlg.className = 'dialog-wrap';
      dlg.innerHTML = '<div class="dialog-con"><p>和 TA 打个招呼</p><textarea id="gta"></textarea></div>' +
        '<div class="dialog-footer"><a class="btn-sure">发送</a></div>';
      w.document.body.appendChild(dlg);
      dlg.querySelector('.btn-sure').addEventListener('click', () => dlg.remove());
    }
  });
  await sleep(160);
  await send(chain.handlers, { type: 'scan' });
  await send(chain.handlers, { type: 'start' });

  for (let i = 0; i < 150 && !chain.stored.records['id:chain']; i++) await sleep(100);
  const chainRec = chain.stored.records['id:chain'];
  eq('容器没反应也能把卡片点开并投出去', chainRec && chainRec.status, 'applied');

  const chainLog = chain.w.document.getElementById('boss-scout-host').shadowRoot
    .getElementById('log').textContent;
  ok('日志写明换了点击目标', chainLog.indexOf('改点卡片标题') >= 0 || chainLog.indexOf('改点详情链接') >= 0, chainLog);
  ok('没有落到「未读到 JD」', chainLog.indexOf('未读到 JD') < 0, chainLog);

  /* ---- 到底之后：给的不是「要不要刷新」，而是真能换一批的动作 ---- */
  const endPage = boot({
    html: `<!DOCTYPE html><html><head><title>BOSS直聘</title></head><body>
    <div class="job-list-box"><ul>${cardHtml('e1', '产品运营', '15-25K')}</ul>
      <div id="end">没有更多了</div></div>
    <div class="job-detail-box" id="panel">详情</div>
    </body></html>`,
    url: 'https://www.zhipin.com/web/geek/jobs?city=101210100&query=%E4%BA%A7%E5%93%81%E8%BF%90%E8%90%A5'
  });
  await sleep(160);
  await send(endPage.handlers, { type: 'scan' });
  const endShadow = endPage.w.document.getElementById('boss-scout-host').shadowRoot;

  const endPending = send(endPage.handlers, { type: 'refresh' });
  for (let i = 0; i < 60 && endShadow.getElementById('confirm').hidden; i++) await sleep(150);
  ok('到底时弹出选择框', !endShadow.getElementById('confirm').hidden);

  const btns = Array.from(endShadow.querySelectorAll('#c-actions button'));
  const labels = btns.map((b) => b.textContent);
  ok('提供「换关键词」而不是只问要不要刷新',
    labels.some((t) => t.indexOf('换关键词') === 0), labels.join(' | '));
  ok('也提供刷新本页与取消',
    labels.some((t) => t.indexOf('刷新本页') === 0) && labels.some((t) => t === '取消'), labels.join(' | '));

  const kwBtn = btns.find((b) => b.textContent.indexOf('换关键词') === 0);
  if (kwBtn) kwBtn.click();
  const endRes = await endPending;

  ok('换关键词返回跳转标记', !!(endRes && endRes.navigate), JSON.stringify(endRes));
  ok('新链接带着画像里的下一个词',
    !!(endRes && /query=SaaS/.test(endRes.url || '')), endRes && endRes.url);
  ok('跳转前落库待扫描标记，加载后能自动接着扫',
    !!(endPage.stored.pending_scan && endPage.stored.pending_scan.at), JSON.stringify(endPage.stored.pending_scan));
  ok('日志写明换了什么', endShadow.getElementById('log').textContent.indexOf('换关键词：SaaS') >= 0,
    endShadow.getElementById('log').textContent);

  /* ---- 详情页请求路径：右侧面板永远不刷新，也要能把 JD 读出来并投出去 ---- */
  console.log('== 详情页请求取 JD ==');
  const jdUrls = [];
  const fj = boot({
    html: `<!DOCTYPE html><html><head><title>BOSS直聘</title></head><body>
    <div class="job-list-box"><ul>
      <li class="job-card-wrapper">
        <div class="job-card-wrap" id="card-f">
          <a href="/job_detail/f900.html">
            <span class="job-name">产品运营</span>
            <span class="job-salary">18-28K</span>
            <h3 class="company-name">丁数据科技</h3>
            <span class="job-area">杭州·西湖区</span>
            <ul class="tag-list"><li>SaaS</li></ul>
          </a>
          <div class="card-ops"><span class="go-chat">立即沟通</span></div>
        </div>
      </li>
    </ul></div>
    <div class="job-detail-box" id="panel"><div class="job-sec-text">请从左侧选择一个岗位查看详情</div></div>
    </body></html>`,
    fetchJd: (url) => {
      jdUrls.push(url);
      return '<html><body><div class="job-sec-text">岗位职责：负责 B 端 SaaS 产品运营，' +
        '数据分析与用户增长，3 年以上经验，熟悉数据看板。</div></body></html>';
    }
  });
  await sleep(160);

  /* 卡片上的按钮做成纯文本 span：没有任何 btn 类名，只能按文本找 */
  const goChat = fj.w.document.querySelector('#card-f .go-chat');
  goChat.addEventListener('click', () => {
    const dlg = fj.w.document.createElement('div');
    dlg.className = 'dialog-wrap';
    dlg.innerHTML = '<div class="dialog-con">发送招呼语</div><textarea></textarea>' +
      '<a class="btn-sure">发送</a>';
    fj.w.document.body.appendChild(dlg);
    dlg.querySelector('.btn-sure').addEventListener('click', () => dlg.remove());
  });

  await send(fj.handlers, { type: 'scan' });
  await send(fj.handlers, { type: 'start' });

  for (let i = 0; i < 80 && !fj.stored.records['id:f900']; i++) await sleep(100);
  await sleep(300);

  const fjLog = fj.w.document.getElementById('boss-scout-host').shadowRoot
    .getElementById('log').textContent;
  ok('按 jobId 请求了详情页', jdUrls.length > 0 && jdUrls[0].indexOf('f900') > 0, jdUrls.join(','));
  ok('日志写明 JD 来自详情页', fjLog.indexOf('JD 来自详情页') >= 0, fjLog);
  eq('面板没刷新也投出去了',
    fj.stored.records['id:f900'] && fj.stored.records['id:f900'].status, 'applied');
  ok('没有落到「未读到 JD」', fjLog.indexOf('未读到 JD') < 0, fjLog);
  ok('没有落到「未找到沟通按钮」', fjLog.indexOf('未找到沟通按钮') < 0, fjLog);

  /* ---- HR 活跃度：两周没上线的 HR，投过去也没人看 ---- */
  console.log('== HR 活跃度 ==');

  const logOf = (h) => h.w.document.getElementById('boss-scout-host').shadowRoot
    .getElementById('log').textContent;

  /* ① 卡片上就写着「1月内活跃」：扫描阶段直接判掉，队列里不该有它 */
  const stale = boot({
    html: `<!DOCTYPE html><html><head><title>BOSS直聘</title></head><body>
    <div class="job-list-box"><ul>
      <li class="job-card-wrapper">
        <div class="job-card-wrap" id="card-stale">
          <a href="/job_detail/stale01.html">
            <span class="job-name">产品运营</span>
            <span class="job-salary">18-28K</span>
            <h3 class="company-name">戊网络科技</h3>
            <span class="job-area">杭州·西湖区</span>
            <ul class="tag-list"><li>SaaS</li></ul>
          </a>
          <div class="job-card-right"><span class="boss-active">1月内活跃</span></div>
        </div>
      </li>
    </ul></div>
    <div class="job-detail-box" id="panel"><div class="job-sec-text">请从左侧选择一个岗位查看详情</div></div>
    </body></html>`
  });
  await sleep(160);
  await send(stale.handlers, { type: 'scan' });
  await sleep(200);

  const staleBadge = stale.w.document.querySelector('#card-stale .bs-badge');
  ok('卡片直接被标成跳过', staleBadge && staleBadge.textContent.indexOf('跳过') >= 0,
    staleBadge && staleBadge.textContent);
  ok('徽章提示写明原因', staleBadge && staleBadge.title.indexOf('HR 久未活跃') >= 0,
    staleBadge && staleBadge.title);

  await send(stale.handlers, { type: 'start' });
  await sleep(400);
  eq('不进投递队列', stale.clicks.good, 0);
  eq('不产生投递记录', Object.keys(stale.stored.records).length, 0);

  /* ② 卡片没写档位，详情页才写「1月内活跃」：请求之后、读 JD 停留之前就停手 */
  const staleDeep = boot({
    fetchJd: () => '<html><body><div class="job-boss-info">王女士 · HR · 1月内活跃</div>' +
      '<div class="job-sec-text">产品运营 岗位职责：负责 B 端 SaaS 产品的用户增长与数据运营，' +
      '要求 3 年以上经验，熟悉数据分析工具。任职要求：本科及以上。</div></body></html>'
  });
  await sleep(160);
  await send(staleDeep.handlers, { type: 'scan' });
  await send(staleDeep.handlers, { type: 'start' });
  /* 每份卡住的那几秒是「滚到卡片 + 停顿」，所以这里等日志，不等固定时长 */
  for (let i = 0; i < 60 && logOf(staleDeep).indexOf('不投了') < 0; i++) await sleep(100);

  eq('详情页说 HR 一个月没上线 → 不点沟通', staleDeep.clicks.chat, 0);
  eq('也不算一次成功投递', staleDeep.stored.stats.applied, 0);
  ok('日志说明为什么没投', logOf(staleDeep).indexOf('不投了') >= 0, logOf(staleDeep));

  /* ③ 只写「近期活跃」这种模糊话：认不出档位，照常投 —— 不能为了筛僵尸岗误杀一片 */
  const vague = boot({
    fetchJd: () => '<html><body><div class="job-boss-info">王女士 · HR · 近期活跃</div>' +
      '<div class="job-sec-text">产品运营 岗位职责：负责 B 端 SaaS 产品的用户增长与数据运营，' +
      '要求 3 年以上经验，熟悉数据分析工具。任职要求：本科及以上。</div></body></html>'
  });
  await sleep(160);
  await send(vague.handlers, { type: 'scan' });
  await send(vague.handlers, { type: 'start' });
  await sleep(400);
  ok('「近期活跃」照常进队列', logOf(vague).indexOf('开始投递，队列 1 个') >= 0, logOf(vague));

  console.log('');
  if (fail) {
    console.log(`✗ ${fail} 项失败 / 共 ${pass + fail} 项\n`);
    fails.forEach((f, i) => console.log(`${i + 1}. ${f}\n`));
    process.exit(1);
  } else {
    console.log(`✓ ${pass} 项全部通过`);
    process.exit(0);
  }
})();

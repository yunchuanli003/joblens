/* joblens content — 流程与 UI。DOM 结构假设全部在 extract.js，纯逻辑在 core.js。
 * 这里不建立任何调试连接、不启动额外浏览器进程。
 */
(function () {
  'use strict';

  var C = window.BossCore;
  var E = window.BossExtract;
  if (!C || !E) { console.warn('[joblens] core/extract 未加载'); return; }
  if (window.__joblensMounted) return;
  window.__joblensMounted = true;

  var PANEL_ID = 'joblens-host';

  var sleep = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };

  /* ---------------------------------------------------------------- 存储 */

  var store = {
    get: function (keys) {
      return new Promise(function (res) { chrome.storage.local.get(keys, function (v) { res(v || {}); }); });
    },
    set: function (obj) {
      return new Promise(function (res) { chrome.storage.local.set(obj, function () { res(); }); });
    },
    remove: function (keys) {
      return new Promise(function (res) { chrome.storage.local.remove(keys, function () { res(); }); });
    }
  };

  function todayStr() {
    var d = new Date();
    return d.getFullYear() + '-' +
      String(d.getMonth() + 1).padStart(2, '0') + '-' +
      String(d.getDate()).padStart(2, '0');
  }

  function nowStr() {
    var d = new Date();
    return todayStr() + ' ' + [d.getHours(), d.getMinutes(), d.getSeconds()]
      .map(function (n) { return String(n).padStart(2, '0'); }).join(':');
  }

  /* ---------------------------------------------------------------- 状态 */

  var State = {
    cfg: null,
    profile: null,
    cards: [],
    hitCount: 0,
    skipCount: 0,
    logs: [],
    lastUrl: location.href,
    busy: false,       // true 表示「页面正在被我们驱动」，此间的跳转是预期内的
    refreshing: false, // 「换一批」进行中，挡掉重复点击
    navGrace: 0,       // 换一批后的一小段时间窗内，跳转也归我们，不清卡片
    pendingScan: false   // 「换一批」触发了整页重载，这次加载后要自动补一次扫描
  };

  function log(msg, level) {
    State.logs.unshift({
      t: new Date().toLocaleTimeString('zh-CN', { hour12: false }),
      m: msg,
      l: level || 'info'
    });
    if (State.logs.length > 40) State.logs.pop();
    UI.renderLog();
  }

  /* ---------------------------------------------------------------- 卡片集合 */

  function cardKey(job) {
    if (job.id) return 'id:' + job.id;
    return 'tx:' + (job.title || '') + '|' + (job.company || '');
  }

  function collect() {
    return E.collectCards(document, State.cfg ? State.cfg.puaMap : null);
  }

  function mergeCards(list) {
    var out = State.cards.slice();
    var byId = new Map();
    var byTx = new Map();

    function txOf(c) { return C.txKey(c.title, c.company); }
    function index(c, force) {
      if (c.id) byId.set(String(c.id), c);
      var t = txOf(c);
      if (t && (force || !byTx.has(t))) byTx.set(t, c);
    }
    out.forEach(function (c) { index(c, false); });

    list.forEach(function (c) {
      var t = txOf(c);
      /* 先按 jobId 认，认不到再按「标题+公司」认：同一岗位这次带链接、下次不带，
         两套键都要能对上，否则同一个岗位会在列表里出现两次，还会被投两遍。 */
      /* 有 jobId 就只信 jobId：同一家公司两个同名岗位（很常见）是两份工作，
         不能因为标题撞上就合并。只有「这张卡拿不到 jobId」时才退到标题+公司。 */
      var old = c.id
        ? (byId.get(String(c.id)) || (t && byTx.get(t) && !byTx.get(t).id ? byTx.get(t) : null))
        : (t ? byTx.get(t) : null);
      if (old) {
        old.el = c.el;                   // 复用已有记录，只刷新 DOM 引用
        /* 活跃度是「会变」的字段：同一个岗位隔一天再看，可能从「3日内活跃」
           变成「本周活跃」。合并时以新读到的为准，读不到就保留旧值。 */
        if (c.activity) old.activity = c.activity;
        if (c.id && !old.id) { old.id = c.id; byId.set(String(c.id), old); }
        if (t) byTx.set(t, old);
        return;
      }
      out.push(c);
      index(c, true);
    });

    State.cards = out.filter(function (c) { return c.el && c.el.isConnected; });
    return State.cards;
  }

  /* ---------------------------------------------------------------- 打分标注 */

  var VERDICT_LABEL = { approve: '推荐', review: '待看', reject: '跳过' };

  function paintBadge(job) {
    if (!job.el || !job.decision) return;
    var b = job.el.querySelector('.bs-badge');
    if (!b) {
      b = document.createElement('div');
      b.className = 'bs-badge';
      try {
        if (getComputedStyle(job.el).position === 'static') job.el.style.position = 'relative';
      } catch (e) { /* ignore */ }
      job.el.appendChild(b);
    }
    var d = job.decision;
    b.dataset.v = d.verdict;
    b.textContent = d.score + ' ' + (VERDICT_LABEL[d.verdict] || d.verdict);
    b.title = d.reasons.join('；') + (job.salarySuspect ? '｜薪资解密存疑，建议人工核对' : '');
  }

  function scoreAll() {
    var hit = 0, skip = 0;
    State.cards.forEach(function (job) {
      job.decision = C.evaluate(job, State.profile, State.cfg.scoring);
      if (job.decision.verdict === 'approve') hit++;
      else if (job.decision.verdict === 'reject') skip++;
      paintBadge(job);
    });
    State.hitCount = hit;
    State.skipCount = skip;
    return hit;
  }

  function clearBadges() {
    document.querySelectorAll('.bs-badge').forEach(function (b) { b.remove(); });
  }
  /* ---------------------------------------------------------------- 等待 */

  function nap(ms, label) {
    if (label && UI.ready) UI.setStatus(label);
    return sleep(ms);
  }

  /* ---------------------------------------------------------------- 扫描 */

  async function scan() {
    if (!State.cfg) return [];
    var cfg = State.cfg;

    /* 先排除「页面根本不是岗位列表」：验证页 / 登录页 / 详情页里没有岗位卡，
       硬扫只会得到「0 个岗位」，反而让人以为是画像配错了 */
    var an = E.anomalyNow();
    if (an.length) {
      UI.setStatus('检测到安全校验');
      log(C.scanDiagnosis(0, 0, an).msg, 'err');
      return [];
    }

    /* 不在岗位列表页就当场停手。滚动一个没有岗位卡的页面没有意义，
       更糟的是它会让「0 个岗位」看起来像选择器坏了，把排查引到错的方向。
       但页面里如果确实有岗位链接（例如改版后的新路径），仍然允许试扫。 */
    if (C.pageKind(location.pathname) !== 'jobs') {
      var looseAnchors = E.qa(document, ['a[href*="job_detail"]']).length;
      if (!looseAnchors) {
        UI.setStatus('不在列表页');
        log(C.scanDiagnosis(0, 0, null, location.pathname).msg, 'err');
        return [];
      }
      log('当前不是标准列表页，按页面内 ' + looseAnchors + ' 个岗位链接试扫', 'warn');
    }

    UI.setStatus('扫描中…');
    clearBadges();
    State.cards = [];
    mergeCards(collect());

    for (var i = 0; i < cfg.limits.scroll_rounds; i++) {
      var before = State.cards.length;
      if (before >= cfg.limits.max_cards) break;

      window.scrollBy({ top: Math.round(window.innerHeight * 0.9), behavior: 'smooth' });
      await sleep(C.rand(1100, 2100));
      mergeCards(collect());

      if (State.cards.length === before) {
        window.scrollBy({ top: Math.round(window.innerHeight * 0.9), behavior: 'smooth' });
        await sleep(C.rand(900, 1600));
        mergeCards(collect());
        if (State.cards.length === before) break;   // 连续两轮无新增，认定到底
      }
    }

    window.scrollTo({ top: 0, behavior: 'smooth' });
    await sleep(400);

    var hit = scoreAll();
    UI.renderStats();
    UI.setStatus('扫描完成');

    var diag = C.scanDiagnosis(
      State.cards.length,
      E.qa(document, ['a[href*="job_detail"]']).length,
      null,
      location.pathname
    );
    if (diag) log(diag.msg, diag.level);
    else log('扫描 ' + State.cards.length + ' 个岗位，推荐 ' + hit + ' 个', 'ok');
    return State.cards;
  }

  /* ---------------------------------------------------------------- 换一批（拉新岗位） */

  /* 用户不知道 BOSS 网页怎么「刷新岗位」，其实是由轻到重的三招：
     ① 加载更多 / 下一页（同一搜索继续翻）
     ② 切「最新发布」排序（换一批排序结果）
     ③ 整页重载（重新请求一次列表）
     判断某招是否真生效只有一个可靠依据：卡片集合里出现了新 jobId。
     按钮是否 disabled、类名怎么写都不可靠——点了没反应就当失败，换下一招。 */
  var REFRESH = { wait_ms: 3500, poll_ms: 300 };

  function onListPage() {
    return /\/web\/geek\/(jobs|recommend)/.test(location.pathname);
  }

  function keysOf(list) {    var m = {};
    (list || []).forEach(function (c) { m[cardKey(c)] = true; });
    return m;
  }

  function hasNewCard(before) {
    var now = collect();
    for (var i = 0; i < now.length; i++) {
      if (!before[cardKey(now[i])]) return true;
    }
    return false;
  }

  async function waitNewCard(before, ms) {
    var end = Date.now() + ms;
    while (Date.now() < end) {
      await sleep(REFRESH.poll_ms);
      if (hasNewCard(before)) return true;
    }
    return false;
  }

  /* 点之前把「点的是什么」一起写进日志：万一还是点错，光看日志就能定位到元素 */
  function elLabel(el) {
    if (!el) return '?';
    var tag = String(el.tagName || '').toLowerCase();
    var cls = String((el.getAttribute && el.getAttribute('class')) || '')
      .split(/\s+/).filter(Boolean).slice(0, 2).join('.');
    return tag + (cls ? '.' + cls : '');
  }

  async function tryControl(el, label, before) {
    if (!el) return false;
    if (E.isOffLimit(el)) {            // 兜底：调用方漏判时也不点岗位卡片/详情区
      log('「' + label + '」落在岗位卡片或详情区里，不点', 'warn');
      return false;
    }
    log('换一批：点「' + label + '」 ' + elLabel(el), 'dim');
    var ok = false;
    /* 这次点击可能引起 SPA 跳转（分页会改 URL），不算用户切页 */
    State.busy = true;
    try {
      E.clickEl(el);
      ok = await waitNewCard(before, REFRESH.wait_ms);
    } finally {
      State.busy = false;
    }
    if (!ok) log('「' + label + '」没带来新岗位', 'dim');
    return ok;
  }

  /* BOSS 的岗位列表是无限滚动：没有「下一页」，滚到底自动加载下一批。
     这是最主要的一招，必须排在找按钮前面——找按钮那三招在 BOSS 上基本都是空的。
     判据仍然只看「有没有新 jobId」，滚动高度变了不算数。
     滚动同时打容器和整页两个目标：容器选择器一旦失配，只滚容器会出现
     「页面纹丝不动却判定到底」的假阴性——扫描用 window 能加载、换一批用 div 加载不了。 */
  async function tryScrollLoad(before) {
    var endWord = E.endOfList();
    if (endWord) {
      log('列表底部写着「' + endWord + '」，这个搜索已经到底', 'dim');
      return false;
    }
    var host = E.findScrollHost();
    log('换一批：滚动加载（' + (host ? elLabel(host) : '整页') + '）', 'dim');
    var ok = false, idle = 0;
    State.busy = true;
    try {
      for (var i = 0; i < 8 && idle < 2; i++) {
        var top0 = E.scrollTopOf(host);
        var h0 = E.scrollHeightOf(host);
        E.scrollToBottom(host);
        if (host) E.scrollToBottom(null);          // 容器选错时靠整页滚动兜底
        await sleep(1000);
        if (hasNewCard(before)) { ok = true; break; }
        var h1 = E.scrollHeightOf(host);
        if (h1 > h0) {                             // 列表长高了，说明正在加载
          idle = 0;
          await sleep(800);
          if (hasNewCard(before)) { ok = true; break; }
        } else if (E.scrollTopOf(host) === top0) {
          idle++;                                  // 滚不动也不长高 = 到底
        } else {
          idle = 0;
        }
      }
    } finally {
      State.busy = false;
      E.scrollToTop(host);              // 回顶部，避免停在底部影响后续点击
      if (host) E.scrollToTop(null);
    }
    if (!ok) log('滚到底也没有新岗位', 'dim');
    return ok;
  }

  /* 「换一批」的最后一招是整页重载。重载后脚本会重新注入，必须有人接着扫描，
     否则用户看到的是面板一闪又变回「待命」，以为按钮没生效。
     用一次性标记把两段流程接起来，60 秒内有效。 */
  function markRescan() {
    return store.set({ pending_scan: { at: Date.now(), path: location.pathname + location.search } });
  }

  /* 换关键词 / 换城市 = 真的换一批：保留经验、学历、规模这些筛选，从第一页重新搜。
     BOSS 没有「换一批」按钮，改条件才是唯一确定能拿到新岗位的方式。
     跳转会销毁当前脚本上下文，所以先把「加载后自动扫描」落库，
     再延迟 300ms 跳转，让 popup 那条消息有机会先回出去。 */
  async function reopenSearch(kind, word, city) {
    var how = kind === 'city' ? ('换城市：' + city) : ('换关键词：' + word);
    var url = C.buildSearchUrl(location.href, kind === 'city' ? { city: city } : { query: word });
    if (!url) {
      log(how + ' 拼不出新链接，请手动改搜索条件', 'warn');
      return null;
    }
    await markRescan();
    UI.setStatus('正在换到 ' + (kind === 'city' ? city : word));
    log('换一批：' + how + ' → ' + url, 'ok');
    setTimeout(function () {
      try { location.href = url; } catch (e) {
        log('无法自动跳转，请手动打开：' + url, 'warn');
      }
    }, 300);
    return { navigate: true, url: url, how: how };
  }

  async function refreshList() {
    if (State.refreshing || !State.cfg) return null;
    /* 一次换一批最多要连试三招（每招 3.5 秒观察窗），期间再点一次会并发点击，
       把 DOM 搅成谁都认不出的状态。用标记挡掉重入。 */
    State.refreshing = true;
    try {
      return await doRefresh();
    } finally {
      State.refreshing = false;
    }
  }

  async function doRefresh() {
    var an = E.anomalyNow();
    if (an.length) {
      log(C.scanDiagnosis(0, 0, an, location.pathname).msg, 'err');
      return null;
    }

    var before = keysOf(collect());
    if (!Object.keys(before).length) {
      UI.setStatus('没有岗位卡片');
      log('当前页没有岗位卡片，先在岗位列表页点「扫描打分」', 'warn');
      return null;
    }

    UI.setStatus('找新岗位…');
    var how = '';

    /* ① 滚动加载（BOSS 的真实机制，排第一） */
    if (await tryScrollLoad(before)) how = '滚动加载';

    /* ② 万一这版页面确实有「加载更多 / 下一页」按钮 */
    if (!how) {
      var more = E.findMoreButton(document);
      if (more && await tryControl(more.el, more.word, before)) how = '「' + more.word + '」';
    }

    if (!how) {
      var next = E.findNextPage(document);
      if (next && await tryControl(next, '下一页', before)) how = '下一页';
    }

    /* ③ 换排序相当于换一批结果 */
    if (!how) {
      var latest = E.findSortLatest(document);
      if (latest && await tryControl(latest.el, latest.word, before)) how = latest.word + ' 排序';
    }

    /* 任何一步把页面点走了（进岗位详情、进聊天页）都必须立刻停手：
       在错误的页面上继续找按钮、继续点，只会越走越远 */
    if (!onListPage()) {
      UI.setStatus('已离开列表页');
      log('页面已离开岗位列表（' + location.pathname + '），换一批中止。请返回列表页重试', 'err');
      return null;
    }

    if (!how) {
      /* 三招都没有：这个搜索在当前条件下确实没有更多岗位了。
         BOSS 没有「换一批」按钮，整页重载也只是把同一批再请求一遍（新发布才会多几条），
         真正能换来新岗位的只有改搜索条件——所以这里给的是可选动作，不是「要不要刷新」。 */
      UI.setStatus('这一页到底了');
      log('滚动、加载更多、下一页、最新排序都没带来新岗位，这个搜索已经到底', 'warn');
      C.REFRESH_TIPS.forEach(function (t) { log('· ' + t, 'dim'); });

      var words = C.searchWords(State.profile);
      var nextWord = C.nextInCycle(words, C.currentQuery(location.href));
      var cities = C.usableCities(State.profile);
      var nextCity = C.nextInCycle(cities, C.currentCityName(State.profile, location.href));

      var acts = [];
      if (nextWord) acts.push({ value: 'kw', label: '换关键词：' + nextWord, primary: true });
      if (nextCity && cities.length > 1) acts.push({ value: 'city', label: '换城市：' + nextCity });
      acts.push({ value: 'reload', label: '刷新本页（还是这一批）' });
      acts.push({ value: 'no', id: 'c-no', label: '取消' });

      var pick = await UI.choose('这一批已经到底了',
        '这个条件下 BOSS 没有更多岗位了，刷新页面只会重新拉同一批。\n换条件才会有新岗位：',
        acts);

      if (pick === 'kw' || pick === 'city') {
        var nav = await reopenSearch(pick, nextWord, nextCity);
        if (nav) return nav;
        UI.setStatus('待命');
        return null;
      }
      if (pick !== 'reload') { UI.setStatus('待命'); return null; }

      await markRescan();
      try { location.reload(); } catch (e) { log('无法自动刷新，请手动按 Ctrl+R', 'warn'); }
      return { reloaded: true };
    }

    /* 分页会改 URL：先同步 lastUrl，否则 1.5 秒后的跳转监听
       会把刚拿到的新卡片当成「用户切页」清空。URL 变化也可能比 3.5 秒的
       观察窗稍晚一点到，再留 5 秒宽限，过期自动失效。 */
    State.lastUrl = location.href;
    State.navGrace = Date.now() + 5000;
    clearBadges();
    mergeCards(collect());          // 断开的旧卡片在这里被自动剔除
    var hit = scoreAll();
    UI.renderStats();

    var added = State.cards.filter(function (c) { return !before[cardKey(c)]; }).length;
    UI.setStatus('已换一批');
    log('换一批完成（' + how + '）：新增 ' + added + ' 个，累计 ' +
      State.cards.length + ' 个，推荐 ' + hit + ' 个', 'ok');
    return { added: added, cards: State.cards.length, hit: hit, how: how };
  }

  /* ---------------------------------------------------------------- 扫描报告 */

  /* 面板和 popup 共用同一份文本：两处各自拼一遍，迟早会长歪 */
  function buildReport() {
    var rep = C.buildScanReport(State.cards, {
      url: location.origin + location.pathname + location.search,
      time: nowStr(),
      profile: State.profile,
      rejectKeywords: (State.cfg && State.cfg.scoring && State.cfg.scoring.reject_keywords) || []
    });
    if (!rep.total) {
      /* 0 张卡是最需要现场信息的情况：把诊断一起写进报告，
         免得来回问「你是在列表页吗」「有没有登录」 */
      var diag = C.scanDiagnosis(
        0,
        E.qa(document, ['a[href*="job_detail"]']).length,
        E.anomalyNow(),
        location.pathname
      );
      rep.text += '\n\n0 张卡片。诊断：' + (diag ? diag.msg : '选择器可能失配');
      rep.text += '\n（还没扫描过就先点「扫描打分」，等状态变成「扫描完成」再导出）';
    }
    return rep;
  }

  /* ---------------------------------------------------------------- 配置 */

  async function refreshFromStorage() {
    var v = await store.get(['config', 'profile']);
    State.cfg = C.deepMerge(C.DEFAULTS, v.config || {});
    State.profile = C.deepMerge(C.PROFILE_TEMPLATE, v.profile || {});
    UI.renderStats();
    if (State.cards.length) scoreAll();
    UI.setStatus('待命');
  }

  /* ---------------------------------------------------------------- UI */

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  var UI = {
    ready: false,
    els: {},

    mount: function () {
      if (document.getElementById(PANEL_ID)) return;
      var host = document.createElement('div');
      host.id = PANEL_ID;
      document.documentElement.appendChild(host);

      var root = host.attachShadow({ mode: 'open' });
      root.innerHTML = [
        '<style>', CSS, '</style>',
        '<div class="wrap">',
        '  <div class="head">',
        '    <span class="dot"></span><b>joblens</b>',
        '    <span class="spacer"></span>',
        '    <button class="icon" id="btn-min" title="折叠">–</button>',
        '  </div>',
        '  <div class="body">',
        '    <div class="stats">',
        '      <div><em id="s-cards">0</em><span>岗位</span></div>',
        '      <div><em id="s-hit">0</em><span>推荐</span></div>',
        '      <div><em id="s-skip">0</em><span>跳过</span></div>',
        '    </div>',
        '    <div class="status" id="status">待命</div>',
        '    <div class="actions">',
        '      <button id="btn-scan" class="primary">扫描打分</button>',
        '      <button id="btn-refresh" title="滚到底自动加载下一批；到底了会让你换关键词或城市">换一批</button>',
        '    </div>',
        '    <div class="log" id="log"></div>',
        '    <div class="foot"><span><a id="btn-opt">设置</a><span class="sep">·</span><a id="btn-report">报告</a></span>',
        '      <span id="hint">换一批会拉新岗位</span></div>',
        '  </div>',
        '</div>',
        '<div class="confirm" id="confirm" hidden>',
        '  <div class="cbox">',
        '    <h3 id="c-title">确认</h3>',
        '    <p id="c-body"></p>',
        '    <div class="cactions" id="c-actions"></div>',
        '  </div>',
        '</div>',
        '<div class="report" id="report" hidden>',
        '  <div class="rbox">',
        '    <h3>扫描报告</h3>',
        '    <p class="rtip">已全选，Ctrl+C 复制后发给开发；也可点「复制」。报告含每条的分数与命中理由。</p>',
        '    <textarea id="r-text" readonly spellcheck="false"></textarea>',
        '    <div class="ractions"><button id="r-close">关闭</button><button id="r-copy" class="primary">复制</button></div>',
        '  </div>',
        '</div>'
      ].join('');

      var $ = function (id) { return root.getElementById(id); };
      this.els = {
        wrap: root.querySelector('.wrap'),
        cards: $('s-cards'), hit: $('s-hit'), skip: $('s-skip'),
        status: $('status'), log: $('log'),
        btnScan: $('btn-scan'), btnRefresh: $('btn-refresh'),
        btnMin: $('btn-min'), btnOpt: $('btn-opt'), hint: $('hint'),
        btnReport: $('btn-report'),
        report: $('report'), rText: $('r-text'), rCopy: $('r-copy'), rClose: $('r-close'),
        confirm: $('confirm'), cTitle: $('c-title'), cBody: $('c-body'),
        cActions: $('c-actions')
      };

      var self = this;

      this.els.btnScan.addEventListener('click', function () {
        if (!State.cfg) return;
        scan().catch(function (e) { log('扫描失败：' + e.message, 'err'); });
      });

      this.els.btnRefresh.addEventListener('click', function () {
        if (!State.cfg) return;
        refreshList().catch(function (e) { log('换一批失败：' + (e && e.message || e), 'err'); });
      });

      this.els.btnMin.addEventListener('click', function () { self.els.wrap.classList.toggle('min'); });

      this.els.btnOpt.addEventListener('click', function () {
        chrome.runtime.sendMessage({ type: 'openOptions' });
      });

      this.els.btnReport.addEventListener('click', function () { self.openReport(); });
      this.els.rClose.addEventListener('click', function () { self.closeReport(); });
      this.els.rCopy.addEventListener('click', async function () {
        var ta = self.els.rText;
        ta.focus();
        try { ta.setSelectionRange(0, ta.value.length); } catch (e) { }
        var ok = false;
        try {
          if (navigator.clipboard && navigator.clipboard.writeText) {
            await navigator.clipboard.writeText(ta.value);
            ok = true;
          }
        } catch (e) { ok = false; }
        if (!ok) { try { ok = document.execCommand('copy'); } catch (e) { ok = false; } }
        self.els.rCopy.textContent = ok ? '已复制' : '请按 Ctrl+C';
        setTimeout(function () { self.els.rCopy.textContent = '复制'; }, 1600);
      });

      this.ready = true;
      this.renderStats();
      this.renderLog();
    },

    /* 多选项弹窗：换一批到底时要给的不止是「是/否」，而是几个真能改变结果的动作。
       options: [{ value, label, primary, id }]，返回被点的 value。 */
    choose: function (title, body, options) {
      var self = this;
      return new Promise(function (resolve) {
        var box = self.els.cActions;
        self.els.cTitle.textContent = title;
        self.els.cBody.textContent = body;
        box.textContent = '';
        box.classList.toggle('stack', (options || []).length > 2);
        var done = function (v) {
          self.els.confirm.hidden = true;
          box.textContent = '';
          resolve(v);
        };
        (options || []).forEach(function (o) {
          var b = document.createElement('button');
          b.textContent = o.label;
          if (o.id) b.id = o.id;
          if (o.primary) b.className = 'primary';
          b.addEventListener('click', function () { done(o.value); });
          box.appendChild(b);
        });
        self.els.confirm.hidden = false;
      });
    },

    confirm: function (title, body) {
      return this.choose(title, body, [
        { id: 'c-no', value: false, label: '取消' },
        { id: 'c-yes', value: true, label: '确认', primary: true }
      ]);
    },

    openReport: function () {
      if (!this.ready) return null;
      var rep = buildReport();
      var text = rep.text;
      this.els.rText.value = text;
      this.els.report.hidden = false;
      try {
        this.els.rText.focus();
        this.els.rText.setSelectionRange(0, text.length);
      } catch (e) { /* ignore */ }
      return rep;
    },

    closeReport: function () {
      if (!this.ready) return;
      this.els.report.hidden = true;
    },

    setStatus: function (s) {
      if (!this.ready) return;
      this.els.status.textContent = s;
    },

    setRunning: function (on) {
      if (!this.ready) return;
      this.els.btnScan.disabled = on;
      this.els.btnRefresh.disabled = on;
      this.els.wrap.classList.toggle('running', on);
      this.els.hint.textContent = on ? '扫描中…' : '换一批会拉新岗位';
    },

    renderStats: function () {
      if (!this.ready) return;
      this.els.cards.textContent = State.cards.length;
      this.els.hit.textContent = State.hitCount;
      this.els.skip.textContent = State.skipCount;
    },

    renderLog: function () {
      if (!this.ready) return;
      this.els.log.innerHTML = State.logs.slice(0, 6).map(function (l) {
        return '<div class="line ' + l.l + '"><i>' + l.t + '</i>' + escapeHtml(l.m) + '</div>';
      }).join('');
    }
  };

  var CSS = [
    ':host{all:initial}',
    '.wrap{position:fixed;right:18px;bottom:76px;width:266px;z-index:2147483000;',
    '  font:13px/1.5 -apple-system,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;',
    '  color:#e6e8ec;background:#14161a;border:1px solid #2a2f38;border-radius:12px;',
    '  box-shadow:0 12px 32px rgba(0,0,0,.45);overflow:hidden;user-select:none}',
    '.wrap.min .body{display:none}',
    '.head{display:flex;align-items:center;gap:7px;padding:9px 12px;background:#1a1d23;border-bottom:1px solid #242932}',
    '.head b{font-size:12.5px;letter-spacing:.4px;font-weight:600}',
    '.dot{width:7px;height:7px;border-radius:50%;background:#5b6472;flex:0 0 auto}',
    '.wrap.running .dot{background:#22c55e;box-shadow:0 0 0 3px rgba(34,197,94,.18);animation:bp 1.6s infinite}',
    '@keyframes bp{0%,100%{opacity:1}50%{opacity:.35}}',
    '.spacer{flex:1}',
    '.icon{width:20px;height:20px;border:0;border-radius:5px;background:#242932;color:#9aa3b2;',
    '  cursor:pointer;font-size:13px;line-height:1;display:flex;align-items:center;justify-content:center}',
    '.icon:hover{background:#2f3542;color:#e6e8ec}',
    '.body{padding:11px 12px 9px}',
    '.stats{display:flex;gap:8px;margin-bottom:9px}',
    '.stats>div{flex:1;background:#1a1d23;border:1px solid #242932;border-radius:8px;padding:6px 0;text-align:center}',
    '.stats em{display:block;font-style:normal;font-size:16px;font-weight:600;color:#e6e8ec;line-height:1.2}',
    '.stats span{display:block;font-size:10.5px;color:#7c8494;margin-top:1px}',
    '.status{font-size:12px;color:#9aa3b2;background:#1a1d23;border-radius:6px;padding:6px 9px;margin-bottom:9px;',
    '  min-height:16px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
    '.actions{display:flex;flex-wrap:wrap;gap:6px;margin-bottom:9px}',
    '.actions button{flex:1 1 calc(50% - 6px);padding:7px 0;border-radius:7px;border:1px solid #2f3542;background:#242932;',
    '  color:#d5d9e0;font-size:12px;cursor:pointer;font-family:inherit;transition:.15s}',
    '.actions button:hover:not(:disabled){background:#2f3542;color:#fff}',
    '.actions button.primary{background:#2563eb;border-color:#2563eb;color:#fff}',
    '.actions button.primary:hover:not(:disabled){background:#3b74f0}',
    '.actions button:disabled{opacity:.38;cursor:not-allowed}',
    '.log{max-height:112px;overflow-y:auto;font-size:11px;line-height:1.6;margin-bottom:8px;',
    '  border-top:1px solid #20242c;padding-top:7px}',
    '.log::-webkit-scrollbar{width:5px}',
    '.log::-webkit-scrollbar-thumb{background:#2f3542;border-radius:3px}',
    '.line{display:flex;gap:5px;color:#9aa3b2;word-break:break-all}',
    '.line i{color:#5b6472;font-style:normal;flex:0 0 auto;font-variant-numeric:tabular-nums}',
    '.line.ok{color:#4ade80}.line.warn{color:#fbbf24}.line.err{color:#f87171}.line.dim{color:#6b7280}',
    '.foot{display:flex;justify-content:space-between;align-items:center;font-size:11px;color:#5b6472;',
    '  border-top:1px solid #20242c;padding-top:7px}',
    '.foot .sep{margin:0 6px;color:#38404d}',
    '.foot a{color:#60a5fa;cursor:pointer;text-decoration:none}',
    '.foot a:hover{text-decoration:underline}',
    '.confirm{position:fixed;inset:0;background:rgba(0,0,0,.55);z-index:2147483001;',
    '  display:flex;align-items:center;justify-content:center}',
    '.confirm[hidden]{display:none}',
    '.report{position:fixed;inset:0;background:rgba(0,0,0,.6);z-index:2147483002;',
    '  display:flex;align-items:center;justify-content:center}',
    '.report[hidden]{display:none}',
    '.rbox{width:min(680px,92vw);max-height:80vh;display:flex;flex-direction:column;',
    '  background:#1a1d23;border:1px solid #2f3542;border-radius:12px;padding:16px}',
    '.rbox h3{margin:0 0 4px;font-size:14px;color:#e6e8ec;font-weight:600}',
    '.rbox .rtip{margin:0 0 10px;font-size:11.5px;color:#7c8494;line-height:1.6}',
    '.rbox textarea{flex:1;min-height:320px;width:100%;box-sizing:border-box;resize:vertical;',
    '  background:#0f1115;color:#cfd4dd;border:1px solid #2f3542;border-radius:8px;padding:10px;',
    '  font:12px/1.65 ui-monospace,Consolas,"Courier New",monospace;user-select:text;white-space:pre}',
    '.rbox textarea:focus{outline:none;border-color:#3b74f0}',
    '.ractions{display:flex;gap:8px;justify-content:flex-end;margin-top:10px}',
    '.ractions button{padding:7px 16px;border-radius:7px;border:1px solid #2f3542;background:#242932;',
    '  color:#d5d9e0;font-size:12.5px;cursor:pointer;font-family:inherit}',
    '.ractions button.primary{background:#2563eb;border-color:#2563eb;color:#fff}',
    '.ractions button.primary:hover{background:#3b74f0}',
    '.cbox{width:300px;background:#1a1d23;border:1px solid #2f3542;border-radius:12px;padding:18px}',
    '.cbox h3{margin:0 0 9px;font-size:14px;color:#e6e8ec;font-weight:600}',
    '.cbox p{margin:0 0 16px;font-size:12.5px;color:#9aa3b2;line-height:1.65;white-space:pre-line}',
    '.cactions{display:flex;gap:8px;justify-content:flex-end;flex-wrap:wrap}',
    '.cactions.stack{flex-direction:column;gap:7px}',
    '.cactions.stack button{width:100%}',
    '.cactions button{padding:7px 18px;border-radius:7px;border:1px solid #2f3542;background:#242932;',
    '  color:#d5d9e0;font-size:12.5px;cursor:pointer;font-family:inherit}',
    '.cactions button:hover{background:#2f3542;color:#fff}',
    '.cactions button.primary{background:#2563eb;border-color:#2563eb;color:#fff}',
    '.cactions button.primary:hover{background:#3b74f0}',
    '.bs-badge{position:absolute;top:6px;right:6px;z-index:9;padding:2px 7px;border-radius:5px;',
    '  font:600 11px/1.5 -apple-system,"Segoe UI","PingFang SC",sans-serif;pointer-events:none;',
    '  letter-spacing:.2px}',
    '.bs-badge[data-v="approve"]{background:rgba(22,163,74,.92);color:#fff}',
    '.bs-badge[data-v="review"]{background:rgba(217,119,6,.92);color:#fff}',
    '.bs-badge[data-v="reject"]{background:rgba(75,85,99,.85);color:#d1d5db}',
    '.bs-badge[data-v="done"]{background:rgba(30,41,59,.92);color:#94a3b8}'
  ].join('');

  /* ---------------------------------------------------------------- 消息 */

  chrome.runtime.onMessage.addListener(function (msg, sender, reply) {
    if (!msg || !msg.type) return;

    if (msg.type === 'ping') {
      reply({
        ok: true,
        cards: State.cards.length,
        hit: State.hitCount,
        skip: State.skipCount
      });
      return;
    }

    if (msg.type === 'scan') {
      scan()
        .then(function () { reply({ ok: true, cards: State.cards.length, hit: State.hitCount }); })
        .catch(function (e) { reply({ ok: false, error: String(e && e.message || e) }); });
      return true;
    }

    if (msg.type === 'refresh') {
      refreshList()
        .then(function (r) {
          reply({
            ok: !!r,
            reloaded: !!(r && r.reloaded),
            navigate: !!(r && r.navigate),
            added: r && r.added,
            hit: r && r.hit,
            how: r && r.how,          // popup 要显示「滚动了 / 点了下一页」，漏传就成了「新岗位」
            url: r && r.url,          // 换条件时把新链接带出去，出问题能直接对着 URL 排查
            cards: State.cards.length
          });
        })
        .catch(function (e) { reply({ ok: false, error: String(e && e.message || e) }); });
      return true;
    }


    if (msg.type === 'report') {
      var rep = buildReport();
      reply({ ok: true, text: rep.text, total: rep.total, counts: rep.counts });
      return;
    }

    /* 页面诊断：选择器对不对、有没有分页控件、详情区在哪，一次全导出来。
       有它就不用再靠「我猜 BOSS 结构 → 你重载 → 还是不对」这个循环。 */
    if (msg.type === 'probe') {
      var text = '';
      try { text = E.probePage(); } catch (e) { text = '诊断失败：' + (e && e.message ? e.message : e); }
      reply({ ok: true, text: text });
      return;
    }

    if (msg.type === 'reload') {
      refreshFromStorage().then(function () { reply({ ok: true }); });
      return true;
    }
  });

  /* ---------------------------------------------------------------- 启动 */

  async function boot() {
    UI.mount();
    await refreshFromStorage();
    log('已就绪', 'dim');

    /* 设置页保存后会广播 reload；但 tabs.query 在部分版本受权限限制，
       这里再挂一层 storage 监听兜底，保证改完画像当前页立刻按新配置打分 */
    if (chrome.storage && chrome.storage.onChanged) {
      chrome.storage.onChanged.addListener(function (changes, area) {
        if (area !== 'local' || (!changes.config && !changes.profile)) return;
        refreshFromStorage().then(function () { log('配置已更新', 'dim'); });
      });
    }

    // SPA 切页不重新加载，需要自己感知
    setInterval(function () {
      if (location.href === State.lastUrl) return;
      State.lastUrl = location.href;
      /* 换一批流程里，跳转是我们自己点出来的，不该清空刚拿到的卡片 */
      if (State.busy || Date.now() < State.navGrace) {
        log('页面跳转（本次操作内）', 'dim');
        return;
      }
      clearBadges();
      State.cards = [];
      State.hitCount = 0;
      UI.renderStats();
      UI.setStatus('页面已切换');
    }, 1500);

    var an = E.anomalyNow();
    if (an.length) {
      UI.setStatus('检测到验证页');
      log('当前页面疑似安全校验（' + an.join(',') + '）' + location.href + '，请手动确认', 'err');
      return;
    }

    /* 「换一批」的最后一招是整页重载，重载后脚本重新注入，得接着扫。
       标记只认 60 秒内的，避免用户明天打开页面时被莫名扫一遍。 */
    var pv = await store.get(['pending_scan']);
    var pending = pv && pv.pending_scan;
    if (pending && pending.at && Date.now() - pending.at < 60000) {
      await store.remove('pending_scan');
      State.pendingScan = true;
    }

    /* 自动扫描：只在岗位列表/推荐页生效，只读、不点击。
       等 2.6 秒让列表渲染完，否则会扫到空列表。 */
    var onList = /\/web\/geek\/(jobs|recommend)/.test(location.pathname);
    var wantScan = State.pendingScan ||
      (State.cfg && State.cfg.safety && State.cfg.safety.auto_start && onList);
    if (wantScan && onList) {
      setTimeout(function () {
        if (State.cards.length) return;
        log(State.pendingScan ? '页面已刷新，自动重新扫描' : '自动扫描开始（可在设置里关掉）', 'dim');
        scan().catch(function (e) { log('自动扫描失败：' + e.message, 'err'); });
      }, 2600);
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot, { once: true });
  } else {
    boot();
  }
})();

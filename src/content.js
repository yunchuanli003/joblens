/* boss-scout content — 流程与 UI。DOM 结构假设全部在 extract.js，纯逻辑在 core.js。
 * 这里不建立任何调试连接、不启动额外浏览器进程。
 */
(function () {
  'use strict';

  var C = window.BossCore;
  var E = window.BossExtract;
  if (!C || !E) { console.warn('[boss-scout] core/extract 未加载'); return; }
  if (window.__bossScoutMounted) return;
  window.__bossScoutMounted = true;

  var PANEL_ID = 'boss-scout-host';

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
    records: {},
    doneIdx: { ids: {}, tx: {} },   // 已投索引（id + 标题|公司），避免已投的岗位被重投
    cards: [],
    appliedToday: 0,
    appliedSession: 0,
    hitCount: 0,
    failures: 0,
    running: false,
    stopFlag: false,
    logs: [],
    lastUrl: location.href,
    busy: false,       // true 表示「页面正在被我们驱动」，此间的跳转是预期内的
    refreshing: false, // 「换一批」进行中，挡掉重复点击
    navGrace: 0,       // 换一批后的一小段时间窗内，跳转也归我们，不清卡片
    pendingScan: false,  // 「换一批」触发了整页重载，这次加载后要自动补一次扫描
    chatDiag: '',        // 最近一次聊天页发送失败的 DOM 证据，跟着报告一起导出
    openDiag: ''         // 最近一次「点开卡片没反应」的现场，同样进报告
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

  /* 只按 jobId 去重会漏：BOSS 的卡片有时取不到 job_detail 链接，jobId 就成了空，
     键从 id:xxx 退化成 tx:标题|公司，两套键永远对不上。改成两套键一起查。 */
  function alreadyApplied(job) {
    return C.isDone(job, State.doneIdx);
  }

  function rebuildDoneIdx() {
    State.doneIdx = C.doneIndex(State.records);
  }

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
    if (alreadyApplied(job)) {
      b.dataset.v = 'done';
      b.textContent = '已投';
      b.title = '此前已投递过，本次会自动跳过';
      return;
    }
    var d = job.decision;
    b.dataset.v = d.verdict;
    b.textContent = d.score + ' ' + (VERDICT_LABEL[d.verdict] || d.verdict);
    b.title = d.reasons.join('；') + (job.salarySuspect ? '｜薪资解密存疑，建议人工核对' : '');
  }

  function scoreAll() {
    var hit = 0;
    State.cards.forEach(function (job) {
      job.decision = C.evaluate(job, State.profile, State.cfg.scoring);
      if (job.decision.verdict === 'approve') hit++;
      paintBadge(job);
    });
    State.hitCount = hit;
    return hit;
  }

  function clearBadges() {
    document.querySelectorAll('.bs-badge').forEach(function (b) { b.remove(); });
  }

  /* ---------------------------------------------------------------- 异常停止 */

  function StopSignal(reason) {
    this.reason = reason;
    this.name = 'StopSignal';
  }
  StopSignal.prototype = Object.create(Error.prototype);

  var STOP_TEXT = {
    user: '已手动停止',
    daily_cap: '已达每日投递上限，自动停止',
    session_cap: '已达本轮上限，自动停止',
    breaker: '连续失败过多，自动停止',
    captcha: '检测到验证 / 风控提示，已停止，请手动处理',
    platform_limit: '检测到平台每日上限弹窗，已停止',
    anomaly: '页面出现安全校验，已停止，请手动完成验证'
  };

  /* 一轮 0 份时最需要知道的就是「卡在哪」。这里把内部原因翻成人话，
     和报告里的诊断一起看，基本能定位到是面板、按钮还是招呼语的问题。 */
  var WHY_TEXT = {
    jd_not_loaded: '读不到 JD',
    no_button: '找不到沟通按钮',
    unconfirmed: '点沟通后页面没反应',
    greeting_failed: '招呼语没发出去',
    chat_not_opened: '聊天页没打开',
    already_contacted: 'BOSS 显示已沟通过',
    stale_hr: 'HR 久未活跃',
    jd_rejected: '读完 JD 判为不合适',
    jumped_detail: '被跳到详情页',
    manual_skip: '手动跳过'
  };

  /* ---------------------------------------------------------------- 可中断等待 */

  async function nap(ms, label) {
    var end = Date.now() + ms;
    while (Date.now() < end) {
      if (State.stopFlag) throw new StopSignal('user');
      var left = Math.max(1, end - Date.now());
      if (label && UI.ready) UI.setStatus(label + ' ' + Math.ceil(left / 1000) + 's');
      await sleep(Math.min(500, left));
    }
  }

  function jitter(sec, ratio) {
    var r = Number(ratio) || 0;
    return Math.max(1, sec * (1 + C.rand(-1, 1) * r));
  }

  async function applyPacing() {
    var p = State.cfg.pacing;
    // 区间随机之上再叠一层抖动，且不低于 1 秒——防止配置成 0 时退化成连点
    var wait = jitter(C.rand(p.delay_min_sec, p.delay_max_sec), p.jitter_ratio);
    await nap(wait * 1000, '下次投递');
    if (p.rest_every > 0 && State.appliedSession > 0 && State.appliedSession % p.rest_every === 0) {
      var rest = C.rand(p.rest_min_sec, p.rest_max_sec);
      log('已投 ' + State.appliedSession + ' 份，休息 ' + Math.round(rest) + ' 秒', 'warn');
      await nap(rest * 1000, '休息中');
    }
  }

  /* ---------------------------------------------------------------- 打开岗位读 JD */

  /* 点开一张卡片，拿右侧面板里的 JD。
     难点在于「点哪儿」：BOSS 不同版本把点击处理绑在不同元素上——外层容器、
     卡片里的 <a>、或者标题。只点容器时有版本一点反应都没有，面板永远不刷新，
     于是「点了没反应」之后直接判失败。这里按顺序试，每次给 2 秒观察。 */
  async function openCard(job, timeoutMs) {
    function inList() {
      return /\/web\/geek\/(jobs|recommend)/.test(location.pathname);
    }

    var before = E.readPanel();
    var beforeText = before ? before.text : '';
    var probe = (job.title || '').slice(0, 4);
    var deadline = Date.now() + Math.min(timeoutMs || 6000, 6000);
    var fallback = null;

    /* 面板文本变了但没包含岗位名（可能是「请从左侧选择」这类占位）就先记着，
       继续等真正的内容；等到最后还是没有就用它，至少证明面板确实动了。 */
    function take() {
      var now = E.readPanel();
      if (!now || now.text === beforeText) return false;
      if (probe && now.text.indexOf(probe) >= 0) { fallback = now.text; return true; }
      fallback = now.text;
      return false;
    }

    var targets = E.cardClickChain(job.el);
    var tried = [];

    for (var i = 0; i < targets.length; i++) {
      if (Date.now() >= deadline) break;
      var t = targets[i];
      if (!t || !t.el || !t.el.isConnected) continue;
      tried.push(t.how);
      if (i > 0) log('卡片没反应，改点' + t.how, 'dim');
      E.clickEl(t.el, { blockNav: t.blockNav });

      /* 剩余时间要平摊给剩下的目标：固定给 2.2 秒的话，后面几个根本轮不到就被
         deadline 截断，等于又退回「只点容器」的老路。 */
      var left = targets.length - i;
      var seg = Math.max(600, Math.floor((deadline - Date.now()) / Math.max(1, left)));
      var segEnd = Math.min(deadline, Date.now() + Math.min(seg, 2200));
      while (Date.now() < segEnd) {
        if (State.stopFlag) throw new StopSignal('user');
        await sleep(160);
        /* 一离开列表页就立刻收手：这时候右侧永远不会有面板，继续等只是在制造「没反应」 */
        if (!inList()) return null;
        if (take()) return fallback;
      }
      if (fallback) return fallback;
    }

    /* 目标都试过了还剩时间：可能只是面板渲染慢，再等一会儿 */
    while (Date.now() < deadline) {
      if (State.stopFlag) throw new StopSignal('user');
      await sleep(160);
      if (!inList()) return null;
      if (take()) return fallback;
    }

    if (fallback) return fallback;
    State.openDiag = E.cardDiag(job.el, tried);
    return null;
  }

  /* ---------------------------------------------------------------- 记录 */

  async function record(job, result) {
    var v = await store.get(['records', 'stats']);
    var records = v.records || {};
    var stats = v.stats || {};
    var today = todayStr();
    if (stats.date !== today) stats = { date: today, applied: 0 };

    records[cardKey(job)] = {
      id: job.id || '',
      title: job.title,
      company: job.company,
      salary: job.salary,
      area: job.area,
      score: job.decision ? job.decision.score : 0,
      verdict: job.decision ? job.decision.verdict : '',
      status: result.ok ? 'applied' : (result.why || 'skipped'),
      note: result.note || '',        // boss_auto / boss_no_msg：这份的招呼语是 BOSS 发的
      ts: Date.now()
    };

    var keys = Object.keys(records);
    if (keys.length > 800) {
      keys.sort(function (a, b) { return (records[a].ts || 0) - (records[b].ts || 0); });
      keys.slice(0, keys.length - 800).forEach(function (k) { delete records[k]; });
    }

    if (result.ok) stats.applied = (stats.applied || 0) + 1;
    await store.set({ records: records, stats: stats });
    State.records = records;
    rebuildDoneIdx();

    if (result.ok) {
      State.appliedToday = stats.applied;
      State.appliedSession++;
      UI.renderStats();
    }
  }

  /* ---------------------------------------------------------------- 单次投递 */

  async function applyOne(job) {
    var cfg = State.cfg;

    /* 队列是一次性快照，跑到中途记录可能已经变了（例如手动投过）。
       下手前再查一次，已经做过的直接跳过，别再读一遍 JD。 */
    if (alreadyApplied(job)) {
      log('已投过，跳过：' + job.title.slice(0, 12), 'dim');
      return { ok: false, why: 'already_done', skip: true };
    }

    if (State.appliedToday >= cfg.limits.daily_apply_max) throw new StopSignal('daily_cap');
    if (State.appliedSession >= cfg.limits.session_apply_max) throw new StopSignal('session_cap');

    if (cfg.safety.manual_confirm) {
      var go = await UI.confirm(
        '确认投递',
        job.title + ' · ' + (job.company || '未知公司') +
        '｜评分 ' + (job.decision ? job.decision.score : '-') +
        '｜' + (job.salary || '薪资未读到')
      );
      if (!go) return { ok: false, why: 'manual_skip', skip: true };
    }

    UI.setStatus('打开：' + job.title.slice(0, 12));
    try { job.el.scrollIntoView({ block: 'center', behavior: 'smooth' }); } catch (e) { }
    await nap(C.rand(700, 1400));

    /* 第一步直接请求详情页 HTML 取 JD：不点卡片、不等面板、不跳页。
       拿不到（未登录 / 被安全校验 / 结构变了）才退回「点卡片读右侧面板」。 */
    var fd = await E.fetchJd(job.id);
    var jdText = fd && fd.text ? fd.text : '';
    var fromFetch = !!jdText;
    if (fromFetch) {
      log('JD 来自详情页：' + jdText.length + ' 字', 'dim');
    } else {
      if (fd && fd.why) log('详情页没取到 JD（' + fd.why + '），改点卡片', 'dim');
      jdText = await openCard(job, cfg.limits.panel_wait_ms);
      if (!jdText && State.openDiag && fd && fd.why) {
        State.openDiag = '详情页请求：' + fd.why + '\n' + State.openDiag;
      }
    }

    /* HR 活跃度复核：卡片上常常只写「近期活跃」这种模糊话，详情页里才是
       「1月内活跃」。这一步放在读 JD 停留之前——真不活跃的岗位能省掉几秒白等。
       判据是「所有能认出的证据都超期」：只要有一条说 HR 最近来过，就放行。 */
    var lim = Number(State.profile.activity_max_idle_days);
    var parsed = [job.activity, fd && fd.activity]
      .filter(Boolean).map(function (a) { return C.activityOf(a); }).filter(Boolean);
    var idle = (lim > 0 && parsed.length && parsed.every(function (p) { return p.days > lim; }))
      ? parsed[0] : null;
    if (idle) {
      log('HR ' + idle.phrase + '，不投了：' + job.title.slice(0, 12), 'dim');
      job.decision = { verdict: 'reject', score: 0, reasons: ['HR 久未活跃：' + idle.phrase] };
      paintBadge(job);
      return { ok: false, why: 'stale_hr', skip: true };
    }

    /* 按钮已经变成「继续沟通」= 之前联系过这个人。好消息是此时还没花时间读 JD，
       正好在这里停手：不重复打招呼、不占额度，也不用等那几秒。 */
    if (contactedBtn(jdText, job)) {
      log('BOSS 显示已沟通过，跳过：' + job.title.slice(0, 12), 'dim');
      return { ok: false, why: 'already_contacted', skip: true, done: true };
    }

    if (!jdText) {
      /* 点开卡片有三种结果，必须分清楚，否则会白等十几秒再判失败：
         ① 右侧出详情面板      → 正常读 JD
         ② 直接跳进聊天页      → 这个岗位没有可读 JD，直接发招呼语
         ③ 跳去岗位详情整页    → 记 jumped，让 runAuto 带回来 */
      if (/\/web\/geek\/chat/.test(location.pathname)) {
        if (greetByBoss()) return await handoffGreeting(job);
        log('点开直接进了聊天页，改为直接发招呼语', 'dim');
        var sentDirect = await sendGreetingInChat(job);
        if (sentDirect) return { ok: true, jumped: true, greeting: true };
        return { ok: false, why: 'greeting_failed', jumped: true };
      }
      if (/\/job_detail\//.test(location.pathname)) {
        log('卡片跳到了详情页，返回列表', 'warn');
        return { ok: false, why: 'jumped_detail', jumped: true };
      }

      /* 右侧没有详情面板 —— 这个版本只能点卡片自带的「立即沟通」。
         这是 BOSS 列表页最朴素的一条路径，点了就进聊天页。 */
      var cardBtn = E.findCardChatButton(job.el);
      if (cardBtn) {
        log('没有详情面板，改点卡片上的「立即沟通」', 'dim');
        return await clickAndFinish(job, cardBtn);
      }

      log('未读到 JD：' + job.title.slice(0, 12) + '（点开后面板没变化，卡片上也没有沟通按钮）', 'warn');
      /* 现场证据直接打到面板：完整版进报告。用户不用开 DevTools 就能看出
         是「链接新开标签页」还是「卡片里根本没有可点元素」。 */
      if (State.openDiag) {
        State.openDiag.split('\n').slice(0, 3).forEach(function (line) {
          if (line.trim()) log(line.trim(), 'dim');
        });
      }
      return { ok: false, why: 'jd_not_loaded' };
    }

    var an = E.anomalyNow();
    if (an.length) {
      log('页面疑似安全校验（' + an.join(',') + '）' + location.href, 'err');
      throw new StopSignal('anomaly');
    }

    // 阅读停留：时长与 JD 长度弱相关，纯随机容易被统计出规律
    var readSec = C.rand(cfg.pacing.read_jd_min_sec, cfg.pacing.read_jd_max_sec);
    if (jdText.length > 900) readSec += C.rand(1, 4);
    UI.setStatus('阅读 JD');
    await nap(readSec * 1000);

    job.text = jdText;
    var d2 = C.evaluate(job, State.profile, cfg.scoring);
    job.decision = d2;
    paintBadge(job);

    if (cfg.safety.read_jd_before_approve && d2.verdict !== 'approve') {
      log('读完 JD 放弃：' + job.title.slice(0, 10) + '（' + d2.score + ' 分）', 'dim');
      return { ok: false, why: 'jd_rejected', decision: d2 };
    }

    var btn = await resolveChatButton(job);
    if (!btn) {
      log('未找到沟通按钮：' + job.title.slice(0, 10), 'warn');
      return { ok: false, why: 'no_button' };
    }

    return await clickAndFinish(job, btn);
  }

  /* 决定点哪个「沟通」按钮，顺序有讲究：
     ① 当前面板确实是这份岗位的 → 用面板里的按钮（不跳页，最稳）
     ② 卡片自带的「立即沟通」→ 点一下直接进聊天页
     ③ 都没有 → 点开卡片把面板调出来，再从面板里取
     没有「整页随便找一个」的兜底：那很可能点到别的岗位的按钮。 */
  async function resolveChatButton(job) {
    var probe = job && job.title ? job.title.slice(0, 4) : '';
    function owned(p) { return p && (!probe || p.text.indexOf(probe) >= 0); }

    var panel = E.readPanel();
    if (owned(panel)) {
      var pb = E.findChatButton(panel.el);
      if (pb) return pb;
    }
    var cb = E.findCardChatButton(job.el);
    /* 卡片上的按钮如果是 target=_blank，点它会开新标签页——当前页什么都不会变，
       只能记一笔「点了没反应」。这种就只能走面板里的按钮。 */
    if (cb && !opensNewTab(cb)) return cb;

    await openCard(job, State.cfg.limits.panel_wait_ms);
    var p2 = E.readPanel();
    if (owned(p2)) return E.findChatButton(p2.el);
    return null;
  }

  function opensNewTab(el) {
    var a = null;
    try { a = el.closest ? el.closest('a[target]') : null; } catch (e) { a = null; }
    if (!a) return false;
    return /^_blank$/i.test(String(a.getAttribute('target') || ''));
  }

  /* 面板或页面里那个「沟通」类按钮，文本已经是「继续沟通」就返回它。
     jdText 为空说明面板压根没刷新，那上面的按钮可能是上一份岗位留下的——
     这种不能信，否则会误跳过新岗位。 */
  function contactedBtn(jdText, job) {
    if (!jdText) return null;
    var panel = E.readPanel();
    if (!panel) return null;
    /* 面板可能是上一份岗位留下的：文本里找不到这份岗位名就不认，
       否则会把「上一单的继续沟通」当成这一单，白跳过一份新岗位。 */
    var probe = job && job.title ? job.title.slice(0, 4) : '';
    if (probe && panel.text.indexOf(probe) < 0) return null;
    var btn = E.findChatButton(panel.el);
    if (!btn) return null;
    return E.isContactedText(E.txt(btn)) ? btn : null;
  }

  /* 点下「沟通」之后的所有判定。两处调用：读得到 JD 时点面板里的按钮，
     读不到 JD 时点卡片上的按钮。流程完全一样，抽出来免得改一处漏一处。 */
  async function clickAndFinish(job, btn) {
    var btnBefore = E.txt(btn);

    /* 兜底：按钮已经是「继续沟通」就别点。点下去只会弹「是否继续沟通」，
       既没发新消息，又会被记成一次成功投递 —— 一笔假账。 */
    if (E.isContactedText(btnBefore)) {
      log('BOSS 显示已沟通过，跳过：' + job.title.slice(0, 12), 'dim');
      return { ok: false, why: 'already_contacted', skip: true, done: true };
    }

    var res = await clickOnce(job, btn, btnBefore);
    if (res) return res;

    /* 第一下常常只是把详情面板展开（卡片按钮就是这个行为）。面板里还有一个
       「立即沟通」，那个才是真正发起沟通的按钮，再点一次。 */
    var panel = E.readPanel();
    var owned = panel && job.title && panel.text.indexOf(job.title.slice(0, 4)) >= 0;
    if (owned && !/\/chat/.test(location.pathname)) {
      var b2 = E.findChatButton(panel.el);
      var t2 = b2 ? E.txt(b2) : '';
      if (E.isContactedText(t2)) {
        log('BOSS 显示已沟通过，跳过：' + job.title.slice(0, 12), 'dim');
        return { ok: false, why: 'already_contacted', skip: true, done: true };
      }
      if (b2 && t2 && t2 !== btnBefore) {
        log('面板已展开，改点面板里的「' + t2 + '」', 'dim');
        res = await clickOnce(job, b2, t2);
        if (res) return res;
      }
    }

    log('点击后无明确反馈：' + job.title.slice(0, 10), 'warn');
    return { ok: false, why: 'unconfirmed' };
  }

  /* 点一次按钮，然后找证据：弹窗 / 跳到聊天页 / 按钮文案变了。
     都没找到就返回 null，由调用方决定要不要再点别的按钮。 */
  async function clickOnce(job, btn, btnBefore) {
    UI.setStatus('发送沟通');
    E.clickEl(btn);
    await nap(C.rand(1200, 2400));

    var dlg = E.topDialog();
    if (dlg) {
      var kind = C.classifyPopupText(E.txt(dlg));

      if (kind === 'captcha') throw new StopSignal('captcha');
      if (kind === 'limit') throw new StopSignal('platform_limit');

      if (kind === 'greeting') {
        var ta = dlg.querySelector('textarea, input[type="text"]');
        if (ta) {
          /* BOSS 自己弹的打招呼框通常已经预填了你在设置里写的招呼语。
             交给 BOSS 时就不该覆盖它——覆盖等于又替你改写一遍；
             只有框是空的才补一句，否则这一下点下去是发空白消息。 */
          var pre = String(ta.value || '').trim();
          var msg = (greetByBoss() && pre) ? pre : C.makeGreeting(job, State.profile);
          if (msg !== pre) {
            ta.focus();
            ta.value = msg;
            ta.dispatchEvent(new Event('input', { bubbles: true }));
            ta.dispatchEvent(new Event('change', { bubbles: true }));
            await nap(C.rand(600, 1100));
          }
        }
        var send = E.dialogActionFor('greeting', dlg);
        if (send) { E.clickEl(send); await nap(C.rand(900, 1600)); }
        log('已发送招呼语：' + job.title.slice(0, 10), 'ok');
        return { ok: true, greeting: true };
      }

      if (kind === 'continue') {
        var cont = E.dialogActionFor('continue', dlg);
        if (cont) E.clickEl(cont);
        await nap(C.rand(700, 1300));
        log('已建立沟通：' + job.title.slice(0, 10), 'ok');
        return { ok: true };
      }

      if (kind === 'unknown') {
        log('遇到未知弹窗，停止：' + E.txt(dlg).slice(0, 28), 'warn');
        throw new StopSignal('user');
      }
    }

    // 无弹窗时用按钮状态变化判断是否已建立沟通
    var panel2 = E.readPanel();
    var owned2 = panel2 && job.title && panel2.text.indexOf(job.title.slice(0, 4)) >= 0;
    var btn2 = owned2 ? E.findChatButton(panel2.el) : null;
    var after = btn2 ? E.txt(btn2) : '';
    if (after && after !== btnBefore) {
      log('已沟通：' + job.title.slice(0, 10) + '（按钮 → ' + after + '）', 'ok');
      return { ok: true };
    }
    if (/\/chat/.test(location.pathname)) {
      /* 网页版「立即沟通」只是跳进聊天页。招呼语由谁发，取决于设置：
         BOSS 已开自动打招呼时扩展必须停手，否则对方会收到两条。 */
      if (greetByBoss()) return await handoffGreeting(job);
      /* 扩展自己发的时候必须真的发出去——原来这里直接 return 成功，等于记假账。 */
      var sent = await sendGreetingInChat(job);
      if (sent) return { ok: true, jumped: true, greeting: true };
      return { ok: false, why: 'greeting_failed', jumped: true };
    }
    return null;
  }

  /* ---------------------------------------------------------------- 聊天页投递 */
  /* 招呼语归谁发，只有两种分工：BOSS 自带的自动打招呼，或者扩展按模板代发。
     两套同时开 = 对方收到两条，所以用开关二选一，代码里也在入口处分叉。 */

  function greetByBoss() {
    return !!(State.cfg && State.cfg.safety && State.cfg.safety.handoff_greeting);
  }

  /* 只把会话打开，不代发招呼语——BOSS 自带的自动打招呼会发。
     但「点了没反应」不能记成已投，所以仍然要拿到一个证据：
     聊天输入框出现了，说明会话真的建立起来了。 */
  async function handoffGreeting(job) {
    UI.setStatus('等 BOSS 自动打招呼');

    var box = null;
    for (var i = 0; i < 16 && !box; i++) {
      await nap(400);
      box = E.chatInput();
    }
    if (!box) {
      log('聊天页没打开（找不到输入框），这份不算投成', 'err');
      return { ok: false, why: 'chat_not_opened', jumped: true };
    }

    /* BOSS 的自动打招呼是页面自己在跳转后发的：等它一下，顺手核一眼发没发 */
    await nap(C.rand(1400, 2400));
    var n = E.chatMsgCount();
    if (n > 0) {
      log('BOSS 已自动打招呼：' + job.title.slice(0, 10), 'ok');
      return { ok: true, jumped: true, handoff: true, note: 'boss_auto' };
    }
    /* 会话开起来了但没看到消息：可能是 BOSS 没配自动打招呼，也可能是它慢半拍。
       记成已投（会话确实建立了，Boss 能收到），但标注出来，报告里能分辨。 */
    log('会话已建立，招呼语交给 BOSS（本条没看到自动消息）', 'warn');
    return { ok: true, jumped: true, handoff: true, note: 'boss_no_msg' };
  }

  /* 「投递」真正发生的时刻就在这个函数里：往聊天输入框写招呼语，再发出去。
     三步都要拿到证据：写进去了、触发了发送、消息确实出现在会话里。
     任何一步没有证据就不算投递成功 —— 宁可下一轮重试，
     也不能在记录里写个「已投」而对方什么都没收到。 */
  async function sendGreetingInChat(job) {
    UI.setStatus('聊天页发招呼语');

    /* 从列表跳过来时会话还要拉一次，输入框不是立刻就有：给到 6 秒 */
    var box = null;
    for (var i = 0; i < 16 && !box; i++) {
      await nap(400);
      box = E.chatInput();
    }
    if (!box) {
      log('聊天页没找到输入框，招呼语没发出（这家需要手动发）', 'err');
      return chatFail();
    }

    /* BOSS 某些版本会预填一句招呼语，那就沿用它的，不覆盖 */
    var msg = E.inputEmpty(box) ? C.makeGreeting(job, State.profile) : E.inputText(box);
    if (E.inputEmpty(box)) writeGreeting(box, msg);

    if (E.inputEmpty(box)) {
      /* 第一次落空很常见（编辑器刚挂载、焦点还在别处）：点一下框里再写一次 */
      log('招呼语没落进输入框，点一下编辑器再写', 'dim');
      E.clickEl(box);
      await nap(C.rand(300, 600));
      writeGreeting(box, msg);
    }
    await nap(C.rand(500, 900));

    if (E.inputEmpty(box)) {
      log('输入框写不进内容，招呼语没发出', 'err');
      return chatFail();
    }

    var before = E.chatMsgCount();

    /* 先点发送按钮（最接近真人），不生效再按回车。
       顺序有讲究：只有「文本还留在框里」才说明上一次没发出去；
       文本已经清空就认为发出去了，绝不再按一次——重复发送会骚扰对方。 */
    var ok = false;
    var btn = E.chatSendButton(box);
    if (btn) {
      log('点发送按钮 ' + elLabel(btn), 'dim');
      E.clickEl(btn);
      await nap(C.rand(900, 1500));
      /* 三条证据任一成立就算发出去了：输入框清空、消息列表出现这句话、会话多了一条 */
      ok = E.inputEmpty(box) || E.chatMessageSent(msg) || E.chatMsgCount() > before;
    }

    if (!ok && !E.inputEmpty(box)) {
      log(btn ? '发送按钮没生效，改按回车' : '没有发送按钮，改用回车', 'dim');
      E.caretToEnd(box);
      E.pressEnter(box);
      await nap(C.rand(900, 1500));
      ok = E.inputEmpty(box) || E.chatMessageSent(msg) || E.chatMsgCount() > before;
    }

    if (ok) {
      log('已发送招呼语：' + job.title.slice(0, 10), 'ok');
      return true;
    }
    log('点了发送但没确认到消息，请人工看一眼', 'warn');
    return chatFail();
  }

  function writeGreeting(box, msg) {
    E.caretToEnd(box);
    if (!E.typeInto(box, msg)) log('编辑器不接受文本，稍后重试', 'dim');
  }

  /* 失败时把聊天页的 DOM 证据一起记下来：面板只显示前几行，
     完整内容进「报告」，这样一次反馈就够定位，不用再来回问结构。 */
  function chatFail() {
    var diag = '';
    try { diag = E.chatDiagnose(); } catch (e) { diag = '聊天页诊断失败：' + (e && e.message || e); }
    State.chatDiag = diag;
    diag.split('\n').slice(0, 4).forEach(function (line) {
      if (line.trim()) log(line.trim(), 'dim');
    });
    return false;
  }

  /* ---------------------------------------------------------------- 自动投递 */

  async function runAuto() {
    if (State.running || !State.cfg) return;
    if (!State.cards.length) await scan();

    var queue = State.cards
      .filter(function (c) {
        return c.decision && c.decision.verdict === 'approve' && !alreadyApplied(c);
      })
      .sort(function (a, b) { return b.decision.score - a.decision.score; });

    var approved = State.cards.filter(function (c) {
      return c.decision && c.decision.verdict === 'approve';
    }).length;
    if (approved > queue.length) {
      log('队列里跳过 ' + (approved - queue.length) + ' 个已投过的岗位', 'dim');
    }

    if (!queue.length) {
      var hits = approved;
      log(hits
        ? '推荐的 ' + hits + ' 个岗位此前都已投过，点「换一批」拉新岗位'
        : '没有达到推荐阈值的岗位，点「换一批」看新岗位，或把画像填准', 'warn');
      return;
    }

    State.running = true;
    State.stopFlag = false;
    State.failures = 0;
    /* 每点一次「开始投递」就是新一轮：计数不归零的话，投满 8 份后
       再点会立刻被判「已达本轮上限」，只能刷新页面才恢复。 */
    if (State.appliedSession > 0) log('上一轮已投 ' + State.appliedSession + ' 份，开始新一轮', 'dim');
    State.appliedSession = 0;
    UI.setRunning(true);
    log('开始投递，队列 ' + queue.length + ' 个', 'ok');

    /* 失败原因按条累计：一轮 0 份时，光看「成功 0 份」根本不知道卡在哪，
       直接把这轮为什么没投成摆出来，用户不用翻报告。 */
    var failTally = {};
    var failTotal = 0;

    try {
      for (var i = 0; i < queue.length; i++) {
        if (State.stopFlag) throw new StopSignal('user');

        var job = queue[i];
        if (!job.el || !job.el.isConnected) {
          mergeCards(collect());
          job = State.cards.find(function (c) { return cardKey(c) === cardKey(job); }) || job;
          if (!job.el || !job.el.isConnected) { log('卡片已失效，跳过', 'warn'); continue; }
        }

        UI.setStatus('第 ' + (i + 1) + '/' + queue.length + ' 个');

        var res;
        try {
          /* 整个 applyOne 期间页面都是我们在驱动：点开岗位、读 JD、点沟通，
             每一步都可能引起 SPA 跳转（BOSS 点「立即沟通」会直接进聊天页）。
             这期间的跳转不能算「用户切页」，否则一轮投递会被自己的动作掐断。 */
          State.busy = true;
          res = await applyOne(job);
        } catch (e) {
          if (e instanceof StopSignal) throw e;
          res = { ok: false, why: 'error:' + (e && e.message ? e.message : e) };
          log('异常：' + (e && e.message ? e.message : e), 'err');
        } finally {
          State.busy = false;
        }

        if (res.skip && !res.done) {
          log('已跳过：' + job.title.slice(0, 10), 'dim');
          continue;
        }

        await record(job, res);

        /* 已经在聊天页了，成不成都要回列表——不回的话后面整个队列都废 */
        if (res.jumped) {
          log('返回列表页', 'dim');
          State.busy = true;         // 返回列表也是我们跳的
          try {
            history.back();
            await nap(C.rand(2000, 3500));
            mergeCards(collect());
          } finally {
            State.busy = false;
          }
        }

        if (res.ok) {
          State.failures = 0;
          paintBadge(job);
        } else {
          var why = res.why || 'unknown';
          failTally[why] = (failTally[why] || 0) + 1;
          failTotal++;
          State.failures++;
          if (State.failures >= State.cfg.safety.consecutive_failure_limit) {
            throw new StopSignal('breaker');
          }
        }

        if (State.appliedSession >= State.cfg.limits.session_apply_max) {
          log('本轮已投满 ' + State.appliedSession + ' 份', 'ok');
          break;
        }
        if (i < queue.length - 1) await applyPacing();
      }
      UI.setStatus('完成');
      log('本轮结束，成功 ' + State.appliedSession + ' 份' +
        (failTotal ? '，没投成 ' + failTotal + ' 份' : ''), 'ok');
      if (failTotal) {
        var parts = [];
        Object.keys(failTally).forEach(function (k) {
          parts.push((WHY_TEXT[k] || k) + '×' + failTally[k]);
        });
        log('没投成的原因：' + parts.join('，'), 'warn');
      }
    } catch (e) {
      if (e instanceof StopSignal) {
        UI.setStatus('已停止');
        log(STOP_TEXT[e.reason] || ('已停止：' + e.reason), e.reason === 'user' ? 'dim' : 'err');
      } else {
        UI.setStatus('出错');
        log('运行出错：' + (e && e.message ? e.message : e), 'err');
      }
    } finally {
      State.running = false;
      State.stopFlag = false;
      UI.setRunning(false);
    }
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
      if (State.stopFlag) break;
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
    if (State.running || State.refreshing || !State.cfg) return null;
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
    /* 聊天页发不出去时，证据要跟着报告走：面板日志只显示 6 行，装不下 DOM 细节 */
    if (State.openDiag) rep.text += '\n\n## 点开卡片诊断（最近一次没反应）\n' + State.openDiag;
    if (State.chatDiag) rep.text += '\n\n## 聊天页诊断（最近一次发送失败）\n' + State.chatDiag;
    return rep;
  }

  /* ---------------------------------------------------------------- 配置 */

  async function refreshFromStorage() {
    var v = await store.get(['config', 'profile', 'stats', 'records']);
    State.cfg = C.deepMerge(C.DEFAULTS, v.config || {});
    State.profile = C.deepMerge(C.PROFILE_TEMPLATE, v.profile || {});
    State.records = v.records || {};
    rebuildDoneIdx();
    State.appliedToday = (v.stats && v.stats.date === todayStr()) ? (v.stats.applied || 0) : 0;
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
        '    <span class="dot"></span><b>boss-scout</b>',
        '    <span class="spacer"></span>',
        '    <button class="icon" id="btn-min" title="折叠">–</button>',
        '  </div>',
        '  <div class="body">',
        '    <div class="stats">',
        '      <div><em id="s-today">0</em><span>今日</span></div>',
        '      <div><em id="s-session">0</em><span>本轮</span></div>',
        '      <div><em id="s-hit">0</em><span>推荐</span></div>',
        '    </div>',
        '    <div class="status" id="status">待命</div>',
        '    <div class="actions">',
        '      <button id="btn-scan">扫描打分</button>',
        '      <button id="btn-refresh" title="滚到底自动加载下一批；到底了会让你换关键词或城市">换一批</button>',
        '      <button id="btn-start" class="primary">开始投递</button>',
        '      <button id="btn-stop" disabled>停止</button>',
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
        today: $('s-today'), session: $('s-session'), hit: $('s-hit'),
        status: $('status'), log: $('log'),
        btnScan: $('btn-scan'), btnStart: $('btn-start'), btnStop: $('btn-stop'),
        btnRefresh: $('btn-refresh'),
        btnMin: $('btn-min'), btnOpt: $('btn-opt'), hint: $('hint'),
        btnReport: $('btn-report'),
        report: $('report'), rText: $('r-text'), rCopy: $('r-copy'), rClose: $('r-close'),
        confirm: $('confirm'), cTitle: $('c-title'), cBody: $('c-body'),
        cActions: $('c-actions')
      };

      var self = this;

      this.els.btnScan.addEventListener('click', function () {
        if (State.running || !State.cfg) return;
        scan().catch(function (e) { log('扫描失败：' + e.message, 'err'); });
      });

      this.els.btnRefresh.addEventListener('click', function () {
        if (State.running || !State.cfg) return;
        refreshList().catch(function (e) { log('换一批失败：' + (e && e.message || e), 'err'); });
      });

      this.els.btnStart.addEventListener('click', async function () {
        if (State.running || !State.cfg) return;
        var go = await self.confirm(
          '开始自动投递',
          '本轮最多 ' + State.cfg.limits.session_apply_max + ' 份，间隔 ' +
          State.cfg.pacing.delay_min_sec + '~' + State.cfg.pacing.delay_max_sec + ' 秒随机。' +
          '今日已投 ' + State.appliedToday + ' / ' + State.cfg.limits.daily_apply_max + '。' +
          '开始后请留在本页不要切走。'
        );
        if (go) runAuto();
      });

      this.els.btnStop.addEventListener('click', function () {
        State.stopFlag = true;
        self.setStatus('正在停止…');
        log('用户点击停止', 'dim');
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
      this.els.btnStart.disabled = on;
      this.els.btnStop.disabled = !on;
      this.els.wrap.classList.toggle('running', on);
      this.els.hint.textContent = on ? '自动投递中' : '换一批会拉新岗位';
    },

    renderStats: function () {
      if (!this.ready) return;
      this.els.today.textContent = State.appliedToday;
      this.els.session.textContent = State.appliedSession;
      this.els.hit.textContent = State.hitCount;
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
        running: State.running,
        cards: State.cards.length,
        hit: State.hitCount,
        applied: State.appliedSession,
        todayApplied: State.appliedToday
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

    if (msg.type === 'start') { runAuto(); reply({ ok: true }); return; }
    if (msg.type === 'stop') { State.stopFlag = true; reply({ ok: true }); return; }

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
        refreshFromStorage().then(function () {
          if (State.running) {
            State.stopFlag = true;
            log('配置已更新，本轮投递停止，请重新扫描', 'warn');
          } else {
            log('配置已更新', 'dim');
          }
        });
      });
    }

    // SPA 切页不重新加载，需要自己感知
    setInterval(function () {
      if (location.href === State.lastUrl) return;
      State.lastUrl = location.href;
      /* 换一批 / 投递流程里，跳转是我们自己点出来的，不该清空刚拿到的卡片 */
      if (State.busy || Date.now() < State.navGrace) {
        log('页面跳转（本次操作内）', 'dim');
        return;
      }
      if (State.running) {
        State.stopFlag = true;
        log('页面已切换，停止投递', 'warn');
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

    /* 自动扫描：只在岗位列表/推荐页生效，只扫描不投递。
       等 2.6 秒让列表渲染完，否则会扫到空列表。 */
    var onList = /\/web\/geek\/(jobs|recommend)/.test(location.pathname);
    var wantScan = State.pendingScan ||
      (State.cfg && State.cfg.safety && State.cfg.safety.auto_start && onList);
    if (wantScan && onList) {
      setTimeout(function () {
        if (State.running || State.cards.length) return;
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

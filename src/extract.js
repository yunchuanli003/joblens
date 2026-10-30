/* boss-scout extract — 页面结构与选择器，纯函数，可在 jsdom 中测试
 *
 * 这里集中了所有对 BOSS 页面结构的假设。真实页面改版时，只需要动 SEL 表。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./core.js'));
  else root.BossExtract = factory(root.BossCore);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (C) {
  'use strict';

  /* 每项按优先级排列，逐个尝试直到命中 */
  var SEL = {
    card: ['.job-card-wrap', 'li.job-card-wrapper', '.job-card-box', '[class*="job-card-wrap"]'],
    link: ['a[href*="job_detail"]'],
    title: ['.job-name', '.job-title', '[class*="job-name"]', '[class*="job-title"]'],
    salary: ['.job-salary', '[class*="job-salary"]', '[class*="salary"]'],
    company: ['.company-name', '.boss-name', '[class*="company-name"]', '[class*="boss-name"]'],
    area: ['.job-area', '.company-location', '[class*="job-area"]', '[class*="job-location"]'],
    tags: ['.tag-list li', '[class*="tag-list"] li', '[class*="job-tags"] span', '.job-card-footer .tag-item'],
    panel: ['.job-detail-box', '#main .job-detail', '.job-detail', '[class*="job-detail"]'],
    chatBtn: ['.btn-startchat', '.op-btn-chat', '[class*="startchat"]', '[class*="btn-chat"]', '[class*="chat-btn"]'],
    /* 换一批：先试结构明确的容器，再退到「按文本找」，但裸 a 必须过 isJobEntry */
    more: ['[class*="load-more"]', '[class*="loadmore"]', '[class*="more-btn"]', '[class*="more-job"]',
      'div[class*="more"]', 'span[class*="more"]'],
    moreLoose: ['a', 'button'],
    pager: ['.page-next', '.pagination .next', '.options-pages a.next', '.pager a.next',
      '[class*="pagination"] [class*="next"]', '[class*="pager"] [class*="next"]', 'a[class*="next"]'],
    sort: ['.job-list-sort a', '.job-list-sort span', '[class*="sort-list"] a',
      '[class*="sort"] a', '[class*="sort"] li', '[class*="filter"] a'],
    dialog: ['.dialog-wrap', '.boss-dialog', '[role="dialog"]', '.dialog-container', '.modal-wrap', '[class*="dialog"]']
  };

  /* ---------------------------------------------------------------- 取值 */

  function q(scope, list) {
    if (!scope) return null;
    for (var i = 0; i < list.length; i++) {
      var el;
      try { el = scope.querySelector(list[i]); } catch (e) { continue; }
      if (el) return el;
    }
    return null;
  }

  function qa(scope, list) {
    if (!scope) return [];
    for (var i = 0; i < list.length; i++) {
      var els;
      try { els = scope.querySelectorAll(list[i]); } catch (e) { continue; }
      if (els && els.length) return Array.prototype.slice.call(els);
    }
    return [];
  }

  function txt(el) {
    if (!el) return '';
    return C.clean(el.innerText || el.textContent || '');
  }

  function isVisible(el) {
    if (!el || !el.isConnected) return false;
    var r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return false;
    var st = null;
    try { st = el.ownerDocument.defaultView.getComputedStyle(el); } catch (e) { return true; }
    if (!st) return true;
    return st.display !== 'none' && st.visibility !== 'hidden' && Number(st.opacity || 1) > 0.05;
  }

  /* 完整鼠标事件序列：一部分前端框架只监听 mousedown / pointerdown。
   * 注意不要在这里 dispatch 'click'——末尾的 el.click() 已经会派发一次，
   * 否则同一个按钮会触发两次点击（对“发送招呼语”这类操作是致命的）。
   */
  /* opts.blockNav：拦住这次点击的「默认跳转」。
     卡片本身就是 <a href="/job_detail/...">，点它浏览器会整页导航、脚本上下文被销毁，
     用户看到的就是「点了没反应」。但 BOSS 自己的点击处理还得收到这个事件，
     所以只 preventDefault，不 stopPropagation。 */
  function clickEl(el, opts) {
    if (!el) return false;
    opts = opts || {};
    var navHost = null;
    var guard = null;
    if (opts.blockNav) {
      var host = el;
      try { host = el.closest('a[href]') || el; } catch (e) { host = el; }
      guard = function (e) {
        if (e && e.preventDefault) e.preventDefault();
      };
      try { host.addEventListener('click', guard, true); } catch (e) { }
      navHost = host;
    }
    try { el.scrollIntoView({ block: 'center', behavior: 'instant' }); } catch (e) { }
    var r = el.getBoundingClientRect();
    var x = r.left + r.width / 2;
    var y = r.top + r.height / 2;
    var base = {
      bubbles: true, cancelable: true, composed: true, view: window,
      clientX: x, clientY: y, screenX: x, screenY: y,
      button: 0, buttons: 1, detail: 1
    };
    var seq = ['pointerover', 'pointerenter', 'mouseover', 'mouseenter',
      'pointermove', 'mousemove', 'pointerdown', 'mousedown',
      'pointerup', 'mouseup'];
    seq.forEach(function (t) {
      try {
        var Ev = (t.indexOf('pointer') === 0 && typeof PointerEvent !== 'undefined') ? PointerEvent : MouseEvent;
        el.dispatchEvent(new Ev(t, base));
      } catch (e) { /* 老浏览器无 PointerEvent 时降级 */ }
    });
    try { el.click(); } catch (e) { }
    if (navHost) {
      setTimeout(function () {
        try { navHost.removeEventListener('click', guard, true); } catch (e) { }
      }, 500);
    }
    return true;
  }

  /* ---------------------------------------------------------------- 卡片 */

  function jobIdFromHref(href) {
    if (!href) return '';
    var m = String(href).match(/job_detail\/([^.?/#]+)/);
    return m ? m[1] : '';
  }

  function readCard(el, puaMap) {
    var linkEl = q(el, SEL.link);
    var href = linkEl ? (linkEl.getAttribute('href') || '') : '';
    var title = txt(q(el, SEL.title));
    if (!title && linkEl) title = txt(linkEl);

    var salaryRaw = txt(q(el, SEL.salary));
    var salary = C.decrypt(salaryRaw, puaMap);
    var suspect = C.hasPua(salaryRaw) && C.salarySuspect(salary);

    var tags = qa(el, SEL.tags).map(txt).filter(Boolean).slice(0, 8);

    /* HR 活跃度：卡片右侧通常写着「今日活跃 / 3日内活跃 / 本月活跃」。
       用 textContent 而不是 innerText 扫——读 innerText 会触发重排，而卡片
       有几十张，这一遍只是正则匹配，用不着排版结果。认不出就是空串。 */
    var act = null;
    try { act = C.activityOf(el.textContent || ''); } catch (e) { act = null; }

    return {
      el: el,
      id: jobIdFromHref(href) || el.getAttribute('data-jobid') || '',
      href: href,
      title: title,
      salary: salary,
      salaryRaw: salaryRaw,
      salarySuspect: suspect,
      company: txt(q(el, SEL.company)),
      area: txt(q(el, SEL.area)),
      tags: tags,
      /* 只留原始短语（如「1月内活跃」）。换算成天数的事交给 core，
         这里不替业务做判断，也不让 extract 依赖打分阈值。 */
      activity: act ? act.phrase : '',
      text: '',
      decision: null
    };
  }

  /* 只收集叶子卡片，避免把列表容器也当成一张卡 */
  function collectCards(scope, puaMap) {
    var doc = scope || document;
    var seen = [];
    var out = [];
    SEL.card.forEach(function (s) {
      var list;
      try { list = doc.querySelectorAll(s); } catch (e) { return; }
      Array.prototype.forEach.call(list, function (el) {
        if (seen.indexOf(el) >= 0) return;
        if (el.querySelector(SEL.card[0])) return;
        if (!isVisible(el)) return;
        var job = readCard(el, puaMap);
        if (!job.title) return;
        seen.push(el);
        out.push(job);
      });
    });
    return out;
  }

  /* ---------------------------------------------------------------- 详情面板 */

  var PANEL_JD_SEL = '.job-sec-text, .job-detail-section, [class*="job-sec-text"], [class*="job-detail-section"]';

  /* 页面上带 job-detail 字样的元素常有七八个：有外层包裹壳、有占位容器、也有真面板。
     只取「第一个」很容易拿到一个文本永远不变的壳，于是点了卡片也判「面板没变化」。
     这里把所有候选都收下来，交给 readPanel 挑真正的那一个。
     注意：这里只用 textContent 量长度。对整页级别的大容器算 innerText 很贵，
     而 readPanel 在等面板时每 160ms 就要跑一次，贵一点就会把整轮拖慢。 */
  function panelCands() {
    var out = [];
    for (var i = 0; i < SEL.panel.length; i++) {
      var list;
      try { list = document.querySelectorAll(SEL.panel[i]); } catch (e) { continue; }
      for (var j = 0; j < list.length && j < 24; j++) {
        var el = list[j];
        var dup = false;
        for (var k = 0; k < out.length; k++) if (out[k].el === el) { dup = true; break; }
        if (dup) continue;
        if (!isVisible(el)) continue;
        var raw = String(el.textContent || '');
        if (raw.length <= 10) continue;
        var sec = false;
        try { sec = !!el.querySelector(PANEL_JD_SEL); } catch (e2) { sec = false; }
        var area = 0;
        try { var r = el.getBoundingClientRect(); area = r.width * r.height; } catch (e3) { area = 0; }
        out.push({ el: el, len: raw.length, sec: sec, area: area });
      }
    }
    return out;
  }

  /* 含 JD 段落的候选优先；同为「含 JD」时取文本最短的那个——包住整页的壳
     也会命中，而真正的面板比它短。没有 JD 标记时退回面积最大的一个。
     innerText 只对最终选中的那个算一次。 */
  function readPanel() {
    var c = panelCands();
    if (!c.length) return null;
    var pick = null;
    for (var i = 0; i < c.length; i++) {
      if (!c[i].sec) continue;
      if (!pick || c[i].len < pick.len) pick = c[i];
    }
    if (!pick) {
      for (var j = 0; j < c.length; j++) {
        if (!pick || c[j].area > pick.area) pick = c[j];
      }
    }
    if (!pick) return null;
    return { el: pick.el, text: txt(pick.el) };
  }

  /* 详情页是服务端渲染的：JD 正文就在 .job-sec-text 里。直接请求这份 HTML
     在本地解析，既不用点卡片、也不用等右侧面板，更不会把脚本上下文导航掉。
     这是「点开后面板没变化」时最稳的一条路。 */
  function parseJdHtml(html) {
    var out = { text: '', activity: '' };
    if (!html || typeof html !== 'string') return out;
    var doc;
    try { doc = new DOMParser().parseFromString(html, 'text/html'); } catch (e) { return out; }

    /* HR 活跃度在详情页里也有一份（招聘者卡片上那句「近期活跃 / 今日活跃」）。
       卡片上没写、或卡片被合并刷新过时，这里能补上——但只有明确档位才用得上。 */
    var act = null;
    try {
      var head = doc.querySelector('[class*="job-boss-info"], [class*="boss-info"], .job-detail-box, [class*="job-detail"]');
      act = C.activityOf((head && head.textContent) || '');
    } catch (e) { act = null; }
    if (act) out.activity = act.phrase;

    var secs = [];
    try { secs = Array.prototype.slice.call(doc.querySelectorAll(PANEL_JD_SEL)); } catch (e) { secs = []; }
    var parts = [];
    for (var i = 0; i < secs.length; i++) {
      var t = String(secs[i].textContent || '').replace(/\s+/g, ' ').trim();
      if (t) parts.push(t);
    }
    var joined = parts.join(' ');
    if (joined.length >= 30) { out.text = joined; return out; }

    /* 有的版本不用 .job-sec-text，JD 直接摊在容器里：按内容特征再捞一遍 */
    var loose = [];
    try { loose = Array.prototype.slice.call(doc.querySelectorAll('[class*="job-detail"], [class*="job-sec"]')); } catch (e) { loose = []; }
    for (var j = 0; j < loose.length; j++) {
      var t2 = String(loose[j].textContent || '').replace(/\s+/g, ' ').trim();
      if (t2.length > 60 && /岗位职责|任职要求|职位描述|工作内容|岗位要求/.test(t2)) { out.text = t2; return out; }
    }
    return out;
  }

  /* 只要 JD 正文的老接口：测试和调用方都不关心活跃度时用它 */
  function jdFromHtml(html) {
    return parseJdHtml(html).text;
  }

  /* 返回 { text, why, activity }。why 只用于诊断，不参与打分。 */
  function fetchJd(id) {
    if (!id) return Promise.resolve({ text: '', why: 'no_id', activity: '' });
    if (typeof fetch !== 'function') return Promise.resolve({ text: '', why: 'no_fetch', activity: '' });
    var url = '/job_detail/' + encodeURIComponent(id) + '.html';
    return fetch(url, {
      credentials: 'include',
      headers: { 'Accept': 'text/html,application/xhtml+xml' }
    })
      .then(function (r) {
        if (!r || !r.ok) return { text: '', why: 'http_' + (r ? r.status : 0), activity: '' };
        return r.text().then(function (html) {
          var head = String(html || '').slice(0, 3000);
          if (/安全验证|请完成验证|访问受限|verify-slider/i.test(head)) return { text: '', why: 'verify', activity: '' };
          var p = parseJdHtml(html);
          return { text: p.text, why: p.text ? 'ok' : 'no_sec', activity: p.activity };
        });
      })
      .catch(function () { return { text: '', why: 'err', activity: '' }; });
  }

  /* ---------------------------------------------------------------- 按钮 */

  var CHAT_TEXT = /^(立即沟通|继续沟通|打招呼|开聊|沟通)$/;

  /* 已联系过的人，BOSS 会把按钮从「立即沟通」改成「继续沟通」。
     看到它就是「这单已经做过了」：再点一遍只会多花十几秒，还会记一笔假成功。 */
  var CONTACTED_TEXT = /^(继续沟通|继续聊|已沟通|已投递|已打招呼|已发送简历)$/;

  function isContactedText(t) {
    return CONTACTED_TEXT.test(String(t || '').trim());
  }

  function findChatButton(scope) {
    var box = scope || document;
    for (var i = 0; i < SEL.chatBtn.length; i++) {
      var el;
      try { el = box.querySelector(SEL.chatBtn[i]); } catch (e) { continue; }
      if (el && isVisible(el)) return el;
    }
    var cands = box.querySelectorAll('a, button, div[class*="btn"], span[class*="btn"]');
    for (var j = 0; j < cands.length; j++) {
      var c = cands[j];
      if (!isVisible(c)) continue;
      var t = txt(c);
      if (t.length <= 6 && CHAT_TEXT.test(t)) return c;
    }
    return null;
  }

  /* ---------------------------------------------------------------- 弹窗 */

  function topDialog() {
    var best = null;
    var bestArea = 0;
    SEL.dialog.forEach(function (s) {
      var list;
      try { list = document.querySelectorAll(s); } catch (e) { return; }
      Array.prototype.forEach.call(list, function (el) {
        if (!isVisible(el)) return;
        var r = el.getBoundingClientRect();
        if (r.width < 180 || r.height < 60) return;
        var area = r.width * r.height;
        if (area > bestArea) { bestArea = area; best = el; }
      });
    });
    return best;
  }

  var ACTION_TEXT = {
    continue: /^(继续沟通|留在此页|继续上次|继续聊天|确定|知道了)$/,
    greeting: /^(发送|发 送|立即发送|确定)$/,
    limit: /^(我知道了|知道了|确定|关闭)$/,
    unknown: /^(取消|关闭|我知道了)$/
  };

  function dialogActionFor(kind, dlg) {
    var wanted = ACTION_TEXT[kind];
    if (!wanted || !dlg) return null;
    var cands = dlg.querySelectorAll('a, button, div[class*="btn"], span[class*="btn"]');
    for (var i = 0; i < cands.length; i++) {
      var c = cands[i];
      if (!isVisible(c)) continue;
      var t = txt(c);
      if (t.length <= 6 && wanted.test(t)) return c;
    }
    return null;
  }

  /* ---------------------------------------------------------------- 滚动加载 */

  /* BOSS 的岗位列表是**无限滚动**：没有「下一页」按钮，滚到底自动 append 下一页。
     所以「换一批」最该做的事是滚动，不是找按钮。
     滚动容器不一定是 window——可能是内部 div，判据是「内容比视口高」。 */
  var SCROLL_SEL = [
    '.job-list-box', '.job-list-container', '.search-job-result', '.job-list-wrap',
    '.job-list', '#job-list-box', '[class*="job-list"]', '.main-content', '#main'
  ];

  function scrollCandidates() {
    var out = [];
    SCROLL_SEL.forEach(function (s) {
      var list;
      try { list = document.querySelectorAll(s); } catch (e) { return; }
      Array.prototype.forEach.call(list, function (el) {
        if (out.indexOf(el) < 0) out.push(el);
      });
    });
    return out;
  }

  /* 只返回「真的能滚」的容器；都不满足就返回 null，交给调用方滚 window。
     最可靠的定位方式是「从第一张卡片往上找」——BOSS 的滚动容器偶尔会挪到
     别的 div 上，而固定选择器表一旦失配，滚动就会打在无关的侧栏上：
     页面纹丝不动，脚本却以为「滚过了，到底了」。 */
  function scrollableAncestor(el) {
    var node = el && el.parentElement;
    var depth = 0;
    while (node && node.nodeType === 1 && depth < 14) {
      var over = '';
      try {
        var st = node.ownerDocument.defaultView.getComputedStyle(node);
        over = String((st && st.overflowY) || '');
      } catch (e) { over = ''; }
      if (node.scrollHeight - node.clientHeight > 80 && /(auto|scroll|overlay)/.test(over)) return node;
      node = node.parentElement;
      depth++;
    }
    return null;
  }

  function findScrollHost() {
    var cards = qa(document, SEL.card);
    for (var c = 0; c < Math.min(cards.length, 3); c++) {
      var near = scrollableAncestor(cards[c]);
      if (near) return near;
    }
    var cands = scrollCandidates();
    for (var i = 0; i < cands.length; i++) {
      var el = cands[i];
      if (!isVisible(el)) continue;
      if (el.scrollHeight - el.clientHeight > 80) return el;
    }
    return null;
  }

  /* 列表底部有没有「没有更多了」。有就没必要再滚：无限滚动的页面滚到底
     不报错、不变化，光看「没有新卡片」分不清是到底了还是选择器错了。 */
  function endOfList() {
    var els = [];
    try { els = document.querySelectorAll('div, p, span, li'); } catch (e) { return ''; }
    var cap = Math.min(els.length, 1500);
    for (var i = 0; i < cap; i++) {
      var el = els[i];
      if (el.children && el.children.length) continue;         // 只看叶子节点，省掉布局开销
      var raw = String(el.textContent || '');
      if (!raw || raw.length > 16) continue;
      if (!C.matchEndText(raw)) continue;
      if (!isVisible(el)) continue;
      if (insideCard(el)) continue;                            // 岗位正文里的「没有更多」不算
      return C.matchEndText(raw);
    }
    return '';
  }

  /* 把列表滚到底。host 为空时滚整页。
     返回滚之前的 scrollTop，调用方据此判断「是不是到底了」。 */
  function scrollToBottom(host) {
    var target = host || document.scrollingElement || document.documentElement;
    var before = target.scrollTop;
    try { target.scrollTop = target.scrollHeight; } catch (e) { }
    try {
      if (!host) window.scrollTo(0, document.body.scrollHeight);
      /* 一些容器只监听 wheel/touch，直接改 scrollTop 不触发懒加载 */
      target.dispatchEvent(new Event('scroll', { bubbles: true }));
    } catch (e) { }
    return before;
  }

  function scrollHeightOf(host) {
    var target = host || document.scrollingElement || document.documentElement;
    return target.scrollHeight || 0;
  }

  function scrollTopOf(host) {
    var target = host || document.scrollingElement || document.documentElement;
    return target.scrollTop || 0;
  }

  function scrollToTop(host) {
    var target = host || document.scrollingElement || document.documentElement;
    try { target.scrollTop = 0; } catch (e) { }
    try { if (!host) window.scrollTo(0, 0); } catch (e) { }
  }

  /* ---------------------------------------------------------------- 换一批控件 */

  /* 卡片里的「查看更多 / 加载更多」是岗位内容，不是翻页控件。
     点下去会直接打开那个岗位，把人从列表页带走——比「没找到按钮」糟得多。
     所以所有翻页控件的查找都必须先过这道门。 */
  var CARD_SEL = '.job-card-wrap, .job-card-wrapper, .job-card-box, [class*="job-card-wrap"]';

  function insideCard(el) {
    try { return !!(el.closest && el.closest(CARD_SEL)); } catch (e) { return false; }
  }

  /* 判断一个元素是否「其实是岗位入口」：自己包着岗位链接，或自己就在岗位链接里 */
  function isJobEntry(el) {
    if (insideCard(el)) return true;
    try {
      if (el.querySelector && el.querySelector('a[href*="job_detail"]')) return true;
    } catch (e) { /* ignore */ }
    var a = null;
    try { a = el.closest ? el.closest('a') : null; } catch (e) { a = null; }
    return !!(a && /job_detail/.test(a.getAttribute('href') || ''));
  }

  /* 右侧详情区里的「查看更多」是公司/相似职位入口，同样会把人带走 */
  var DETAIL_SEL = '.job-detail-box, .job-detail, [class*="job-detail"]';

  function inDetailPanel(el) {
    try { return !!(el.closest && el.closest(DETAIL_SEL)); } catch (e) { return false; }
  }

  function isOffLimit(el) {
    return isJobEntry(el) || inDetailPanel(el);
  }

  /* 卡片里的 <a href="/job_detail/..."> 是**整页跳转**，点它脚本上下文直接销毁，
     用户看到的就是「投递点了没反应」。所以只能点容器，靠 BOSS 的事件委托出右侧详情。
     点容器没反应时，改走卡片自带的「立即沟通」按钮（见 findCardChatButton）。 */
  function cardClickTarget(cardEl) {
    return cardEl || null;
  }

  /* 点开一张卡片要按顺序试几个目标。只点容器是不够的：BOSS 有的版本把点击处理
     绑在卡片里的 <a> 或标题上，点外层 div 一点反应都没有，右侧面板永远不刷新。
     顺序按「越像可点区域越靠后」排：先试容器（最安全），不行再试标题、最后试链接。
     标题和链接必须 blockNav，否则一导航就把脚本上下文弄没了。 */
  function cardClickChain(cardEl) {
    var out = [];
    if (!cardEl) return out;
    function push(el, how, blockNav) {
      if (!el) return;
      for (var i = 0; i < out.length; i++) if (out[i].el === el) return;
      out.push({ el: el, how: how, blockNav: !!blockNav });
    }

    push(cardEl, '卡片容器');
    var li = null;
    try { li = cardEl.closest('li'); } catch (e) { li = null; }
    if (li && li !== cardEl) push(li, '卡片外层');
    push(q(cardEl, SEL.title), '卡片标题', true);
    push(q(cardEl, SEL.link), '详情链接', true);
    return out;
  }

  /* 点不开时把现场写下来。面板到底有没有、链接是不是新开标签页，
     这两条决定了下一步该改什么，比「点开后面板没变化」有用得多。 */
  function cardDiag(cardEl, tried, extra) {
    var L = [];
    tried = tried || [];
    if (extra && extra.length) Array.prototype.push.apply(L, extra);
    L.push('点开卡片：试过 ' + tried.length + ' 个目标（' + (tried.join(' → ') || '无') + '）');
    var link = q(cardEl, SEL.link);
    if (link) {
      var href = String(link.getAttribute('href') || '');
      var tg = String(link.getAttribute('target') || '');
      L.push('  链接 href=' + href.slice(0, 70) + ' target=' + (tg || '无'));
      if (/^_blank$/i.test(tg)) L.push('  → target=_blank：点了会开新标签页，当前页永远不会变');
    } else {
      L.push('  卡片里没有 a[href*="job_detail"]');
    }
    var panels = 0;
    try { panels = document.querySelectorAll('[class*="job-detail"]').length; } catch (e) { panels = -1; }
    L.push('  页面 [class*="job-detail"] 元素 ' + panels + ' 个');
    var cands = panelCands();
    if (cands.length) {
      var brief = [];
      for (var i = 0; i < cands.length && i < 4; i++) {
        brief.push(descEl(cands[i].el, 18) + '(' + cands[i].len + '字' + (cands[i].sec ? ',含JD' : '') + ')');
      }
      L.push('  可读面板候选 ' + cands.length + ' 个：' + brief.join(' / '));
    } else {
      L.push('  可读面板候选 0 个：没有任何可见的 job-detail 容器');
    }
    var cardChat = findCardChatButton(cardEl);
    L.push('  卡片沟通按钮：' + (cardChat ? descEl(cardChat, 16) : '没有'));
    var btn = null;
    try { btn = cardEl.querySelector('a, button'); } catch (e) { btn = null; }
    if (btn) L.push('  卡片内首个可点元素：' + descEl(btn, 20));
    var html = '';
    try { html = String(cardEl.outerHTML || ''); } catch (e) { html = ''; }
    if (html) L.push('  卡片 HTML：' + html.slice(0, 400));
    return L.join('\n');
  }

  /* 列表卡片上的「立即沟通」按钮：部分版本 hover 才显示，所以不检查可见性，
     存在即用——点下去直接进聊天页，是 BOSS 最稳的一条路径。 */
  function findCardChatButton(cardEl) {
    if (!cardEl) return null;
    for (var i = 0; i < SEL.chatBtn.length; i++) {
      var el = null;
      try { el = cardEl.querySelector(SEL.chatBtn[i]); } catch (e) { el = null; }
      if (el && !el.disabled) return el;
    }
    /* 类名兜底：新版卡片把按钮做成 <span>立即沟通</span>，一个 btn 类名都没有。
       只在卡片内按文本找，并排除卡片自己的详情链接（点了会整页跳走）。 */
    var cands = null;
    try { cands = cardEl.querySelectorAll('a, button, span, div'); } catch (e) { return null; }
    var hits = [];
    for (var j = 0; j < cands.length && j < 240; j++) {
      var c = cands[j];
      if (c === cardEl || c.disabled) continue;
      /* 先用 textContent 做廉价预筛：卡片里的包裹层文本都很长，
         直接对每个 div 算 innerText 在慢环境里能拖到几秒。 */
      var raw = String(c.textContent || '');
      if (!raw || raw.length > 8) continue;
      var t = txt(c);
      if (!t || t.length > 6 || !CHAT_TEXT.test(t)) continue;
      var a = null;
      try { a = c.closest('a[href]'); } catch (e) { a = null; }
      if (a && /job_detail/.test(a.getAttribute('href') || '')) continue;
      hits.push(c);
    }
    if (!hits.length) return null;
    /* 取最深的那个：外层包裹 div 也含同样文字，点包裹层不会触发按钮自己的处理 */
    var best = hits[0];
    for (var k = 1; k < hits.length; k++) {
      try { if (best.contains(hits[k])) best = hits[k]; } catch (e) { }
    }
    return best;
  }

  /* 按文本找可点元素。文本匹配规则在 core（可单测），这里只负责遍历 DOM。
     选择器顺序即优先级：结构明确的容器排在裸 a/button 前面。 */
  function findByText(scope, selectors, matcher, maxLen) {
    var box = scope || document;
    for (var i = 0; i < selectors.length; i++) {
      var list;
      try { list = box.querySelectorAll(selectors[i]); } catch (e) { continue; }
      var cap = Math.min(list.length, 400);      // 整页 a 元素可能有几百个，限个上限
      for (var j = 0; j < cap; j++) {
        var el = list[j];
        if (!isVisible(el)) continue;
        if (isOffLimit(el)) continue;            // 岗位卡片/详情区/岗位链接一律不点
        var t = txt(el);
        if (!t) continue;
        if (maxLen && t.length > maxLen) continue;
        var word = matcher(t);
        if (word) return { el: el, word: word };
      }
    }
    return null;
  }

  function findMoreButton(scope) {
    /* 结构明确的先用 12 字上限（「点击加载更多职位」这类长文案）；
       裸 a/button 退到 8 字，并靠 isJobEntry 挡掉岗位卡片。 */
    return findByText(scope, SEL.more, C.matchMoreText, 12) ||
      findByText(scope, SEL.moreLoose, C.matchMoreText, 8);
  }

  function findSortLatest(scope) {
    return findByText(scope, SEL.sort, C.matchLatestText, 6);
  }

  /* 分页器的「下一页」在禁用状态下仍是 <a>，只是多了个 class。
     类名不可靠，所以只做「明显禁用」的排除，真正的判据是点完有没有新卡片。 */
  function pagerDisabled(el) {
    var cls = String(el.getAttribute('class') || '');
    if (/(^|[\s_-])(disabled|is-disabled|forbid)([\s_-]|$)/i.test(cls)) return true;
    if (el.getAttribute('aria-disabled') === 'true') return true;
    return false;
  }

  function findNextPage(scope) {
    var box = scope || document;
    for (var i = 0; i < SEL.pager.length; i++) {
      var list;
      try { list = box.querySelectorAll(SEL.pager[i]); } catch (e) { continue; }
      for (var j = 0; j < list.length; j++) {
        var el = list[j];
        if (!isVisible(el) || pagerDisabled(el)) continue;
        return el;
      }
    }
    var byText = findByText(box, ['a', 'button', 'li', 'span'], function (t) {
      return (t === '下一页' || t === '下页') ? '下一页' : '';
    }, 3);
    return byText && !pagerDisabled(byText.el) ? byText.el : null;
  }

  /* ---------------------------------------------------------------- 聊天页 */

  /* 网页版「立即沟通」只是把页面跳到 /web/geek/chat，一句话都没发出去。
     真正的投递动作是「把招呼语写进编辑器 → 触发发送 → 确认消息真的出现在会话里」，
     所以这几个定位直接决定投递是不是真的发生了。

     BOSS 的聊天页改版很频繁，类名整批换过，而「输入框在会话面板底部、面积最大」
     这个几何事实没变过。所以先按类名试，找不到就按位置兜底——
     不要把成败押在一串会变的字符串上。 */
  var CHAT_SEL = {
    input: ['.chat-input', '#chat-input', '.chat-editor', '[class*="chat-input"]',
      '.edit-area', 'div[contenteditable="true"]', 'textarea[class*="input"]',
      '[class*="editor"] [contenteditable="true"]'],
    send: ['.btn-send', '[class*="btn-send"]', '[class*="send-btn"]',
      'button[class*="send"]', '[class*="send-area"] [class*="btn"]', '[class*="send"]'],
    msg: ['.chat-message', '[class*="message-item"]', '[class*="chat-msg"]',
      '[class*="message-list"] li', '.message-list li', '[class*="msg-item"]',
      '[class*="chat-item"]']
  };

  var SEND_WORDS = ['发送', '发 送', '立即发送', '发送消息'];

  function isDisabled(el) {
    if (!el) return true;
    if (el.disabled) return true;
    if (el.getAttribute && el.getAttribute('aria-disabled') === 'true') return true;
    var cls = String((el.getAttribute && el.getAttribute('class')) || '');
    return /(^|[\s_-])(disabled|is-disabled|forbid)([\s_-]|$)/i.test(cls);
  }

  /* 聊天页顶部还有搜索框、备注输入框，它们也是 contenteditable。
     点错它们不会报错，只会把招呼语搜进「搜索」里——所以统一排除。 */
  function inSearchBox(el) {
    if (!el || !el.closest) return false;
    try { return !!el.closest('[class*="search"], form[role="search"], header, nav'); } catch (e) { return false; }
  }

  function isEditable(el) {
    if (!el || !el.isConnected) return false;
    if (String(el.tagName || '').toLowerCase() === 'textarea') return true;
    return String(el.getAttribute('contenteditable') || '').toLowerCase() === 'true';
  }

  /* 会话面板底部的编辑器：面积大、位置靠下、不在搜索栏里。
     聊天页里还有搜索框、备注框，它们要么小要么在顶部，这套排序能把它们挤下去。 */
  function editableCandidates() {
    var out = [];
    var list = [];
    try { list = document.querySelectorAll('[contenteditable="true"], textarea'); } catch (e) { return out; }
    for (var i = 0; i < list.length; i++) {
      var el = list[i];
      if (isDisabled(el)) continue;
      if (inSearchBox(el)) continue;
      var r = null;
      try { r = el.getBoundingClientRect(); } catch (e) { r = null; }
      if (!r || r.width < 40 || r.height < 12) continue;
      out.push({ el: el, bottom: r.bottom, area: r.width * r.height });
    }
    out.sort(function (a, b) { return (b.bottom - a.bottom) || (b.area - a.area); });
    return out;
  }

  function chatInput() {
    for (var i = 0; i < CHAT_SEL.input.length; i++) {
      var list;
      try { list = document.querySelectorAll(CHAT_SEL.input[i]); } catch (e) { continue; }
      for (var j = 0; j < list.length; j++) {
        var el = list[j];
        if (!isVisible(el)) continue;
        if (inSearchBox(el)) continue;
        if (isEditable(el)) return el;
        /* 有的版本把编辑器套在 .chat-input 里面：外壳不是可编辑元素，
           真正的输入区是它的子节点，那就往下一层找 */
        var inner = null;
        try { inner = el.querySelector('[contenteditable="true"], textarea'); } catch (e) { inner = null; }
        if (inner && isVisible(inner)) return inner;
      }
    }
    var cands = editableCandidates();
    return cands.length ? cands[0].el : null;
  }

  /* 发送键：先在被点编辑器附近找（往上 4 层），再退到整页。
     只返回「此刻可用」的那个——灰着的按钮点下去等于没点，
     而「键是灰的」本身不是失败，回车还能发。 */
  function hasInnerCandidate(el) {
    try {
      return !!(el.querySelector && el.querySelector('button, a, [role="button"], [class*="send"], [class*="btn"]'));
    } catch (e) { return false; }
  }

  function pickSend(list, skipContainers) {
    var cap = Math.min(list.length, 300);
    for (var i = 0; i < cap; i++) {
      var el = list[i];
      if (!isVisible(el)) continue;
      if (skipContainers && hasInnerCandidate(el)) continue;   // 取最里层那个，别点外层容器
      var t = txt(el);
      if (t.length > 8) continue;
      var cls = String(el.getAttribute('class') || '');
      var byText = SEND_WORDS.indexOf(t) >= 0;
      /* 类名兜底只认「没有文字的图标按钮」：「发送简历」这种按钮类名里也有 send，
         点下去就把简历发出去了，绝对不能当成聊天发送键。 */
      var byCls = !t && /(btn-send|send-btn)/i.test(cls);
      if (!byText && !byCls) continue;
      if (!isDisabled(el)) return el;
    }
    return null;
  }

  function scanSend(scope) {
    var strict = [], loose = [];
    try { strict = scope.querySelectorAll('button, a, [role="button"]'); } catch (e) { strict = []; }
    try { loose = scope.querySelectorAll('[class*="send"], [class*="btn"]'); } catch (e) { loose = []; }
    return pickSend(strict, false) || pickSend(loose, true);
  }

  function chatSendButton(editor) {
    var scope = editor || null;
    var depth = 0;
    while (scope && depth < 4) {
      var hit = scanSend(scope);
      if (hit) return hit;
      scope = scope.parentElement;
      depth++;
    }
    return scanSend(document);
  }

  /* 光标放到末尾：execCommand 需要选区落在编辑器内部，否则一个字也插不进去 */
  function caretToEnd(el) {
    if (!el) return false;
    try { el.focus(); } catch (e) { }
    try {
      var r = document.createRange();
      r.selectNodeContents(el);
      r.collapse(false);
      var sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(r);
      return true;
    } catch (e) { return false; }
  }

  /* 往输入框写文字。contenteditable 必须走 execCommand，走的是真实编辑管线：
     只改 textContent 再派发 input，受控组件读不到，发送键会一直是灰的，
     点了也什么都不发生——这正是「聊天页发不出去」最典型的样子。 */
  function typeInto(el, text) {
    if (!el) return false;
    caretToEnd(el);
    var tag = String(el.tagName || '').toLowerCase();
    if (tag === 'textarea' || tag === 'input') {
      el.value = text;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    }
    try {
      if (typeof document.execCommand === 'function') {
        var ok = document.execCommand('insertText', false, text);
        if (ok && txt(el).length) return true;
      }
    } catch (e) { /* 老浏览器或 jsdom 没有 execCommand */ }
    /* 兜底：直接改内容，并把 beforeinput/input 都派发一遍，尽量贴近真实输入 */
    try {
      el.textContent = text;
      var ev;
      try {
        ev = new InputEvent('beforeinput', {
          bubbles: true, cancelable: true, inputType: 'insertText', data: text
        });
      } catch (e1) { ev = new Event('beforeinput', { bubbles: true }); }
      el.dispatchEvent(ev);
      try {
        ev = new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text });
      } catch (e2) { ev = new Event('input', { bubbles: true }); }
      el.dispatchEvent(ev);
      el.dispatchEvent(new Event('change', { bubbles: true }));
    } catch (e3) { return false; }
    caretToEnd(el);
    return true;
  }

  /* 回车发送。有的版本没有「发送」按钮，或者按钮灰着，
     但编辑器一定会监听 Enter——这是最后一条可靠的发送路径。 */
  function pressEnter(el) {
    if (!el) return false;
    try { el.focus(); } catch (e) { }
    var win = (el.ownerDocument && el.ownerDocument.defaultView) || window;
    var KE = win && win.KeyboardEvent;
    var base = {
      key: 'Enter', code: 'Enter', keyCode: 13, which: 13,
      bubbles: true, cancelable: true, composed: true
    };
    ['keydown', 'keypress', 'keyup'].forEach(function (t) {
      try {
        var ev = KE ? new KE(t, base) : new (win.Event)(t, { bubbles: true, cancelable: true });
        el.dispatchEvent(ev);
      } catch (e) { /* ignore */ }
    });
    return true;
  }

  /* 输入框当前文本：textarea/input 读 value，contenteditable 读文本节点 */
  function inputText(el) {
    if (!el) return '';
    var tag = String(el.tagName || '').toLowerCase();
    if (tag === 'textarea' || tag === 'input') return String(el.value || '');
    return txt(el);
  }

  function inputEmpty(el) {
    return !inputText(el);
  }

  /* 会话里的消息条数。选择器可能全落空，所以它只作为「有没有变化」的辅助证据，
     单独为 0 不代表没发出去。 */
  function chatMsgCount() {
    var n = 0;
    for (var i = 0; i < CHAT_SEL.msg.length; i++) {
      var list;
      try { list = document.querySelectorAll(CHAT_SEL.msg[i]); } catch (e) { continue; }
      if (list.length > n) n = list.length;
    }
    return n;
  }

  /* 消息列表里出现这句话 = 发出去了。用前 8 个字做探针，
     过短（<4）不做判断，避免「你好」这种到处都有的词造成误判。 */
  function chatMessageSent(text) {
    var probe = String(text || '').trim().slice(0, 8);
    if (probe.length < 4) return false;
    for (var i = 0; i < CHAT_SEL.msg.length; i++) {
      var list;
      try { list = document.querySelectorAll(CHAT_SEL.msg[i]); } catch (e) { continue; }
      for (var j = 0; j < list.length; j++) {
        if (txt(list[j]).indexOf(probe) >= 0) return true;
      }
    }
    return false;
  }

  /* 发送失败时把证据直接写进日志：不用再问「你那边 DOM 长什么样」，
     编辑器尺寸、发送键候选、消息条数一次全带出来。 */
  function chatDiagnose() {
    var L = [];
    L.push('聊天页诊断 ' + location.pathname + (location.search ? location.search.slice(0, 30) : ''));
    var eds = [];
    try { eds = document.querySelectorAll('[contenteditable="true"], textarea'); } catch (e) { eds = []; }
    L.push('可编辑元素 ' + eds.length + ' 个');
    var n = Math.min(eds.length, 4);
    for (var i = 0; i < n; i++) {
      var r = null;
      try { r = eds[i].getBoundingClientRect(); } catch (e) { r = null; }
      L.push('  ' + descEl(eds[i], 10) + ' ' +
        (r ? Math.round(r.width) + 'x' + Math.round(r.height) : '?') +
        (isVisible(eds[i]) ? '' : '（不可见）'));
    }
    var btn = chatSendButton(chatInput());
    L.push('发送键：' + (btn ? descEl(btn, 6) : '未找到可用按钮（会走回车发送）'));
    var cands = [];
    try { cands = document.querySelectorAll('button, a, [class*="send"]'); } catch (e) { cands = []; }
    var shown = 0;
    for (var j = 0; j < cands.length && shown < 5; j++) {
      if (!isVisible(cands[j])) continue;
      if (txt(cands[j]).length > 10) continue;
      L.push('  候选 ' + descEl(cands[j], 8));
      shown++;
    }
    L.push('消息条数：' + chatMsgCount());
    return L.join('\n');
  }

  /* ---------------------------------------------------------------- 页面诊断 */

  /* 选择器只能靠猜的时候，猜十次不如看一次真实 DOM。
     这里把「定位问题所需的全部证据」压成一段可复制的纯文本：
     每个候选选择器命中多少、卡片长什么样、有没有分页控件、详情区在哪、
     沟通按钮是什么、页面底部有哪些可点元素。 */
  function descEl(el, maxLen) {
    if (!el) return '?';
    var tag = String(el.tagName || '').toLowerCase();
    var cls = String((el.getAttribute && el.getAttribute('class')) || '')
      .split(/\s+/).filter(Boolean).slice(0, 3).join('.');
    var t = '';
    try { t = (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, maxLen || 16); } catch (e) { t = ''; }
    return tag + (cls ? '.' + cls : '') + (t ? ' 「' + t + '」' : '');
  }

  function countSel(s) {
    try { return document.querySelectorAll(s).length; } catch (e) { return -1; }
  }

  function probePage() {
    var L = [];
    L.push('# boss-scout 页面诊断');
    L.push('url ' + location.href);
    L.push('path ' + location.pathname);

    L.push('');
    L.push('## 卡片选择器命中');
    SEL.card.forEach(function (s) { L.push('  ' + s + ' → ' + countSel(s)); });
    var cards = collectCards(document, null);
    L.push('解析出卡片 ' + cards.length + ' 个');
    /* HR 活跃度只认明确档位，认不出就不筛。所以真机上「能不能读到」必须能自证：
       一张都读不到时，多半是档位写在别的容器里，改 C.ACTIVITY_RULES 前先看这行。 */
    var withAct = cards.filter(function (c) { return c.activity; });
    L.push('卡片带活跃度 ' + withAct.length + '/' + cards.length +
      (withAct.length ? '（例：' + withAct.slice(0, 3).map(function (c) { return c.activity; }).join('、') + '）'
        : '（读不到就不按活跃度筛，不会误杀）'));
    var first = null;
    try { first = document.querySelector(SEL.card.join(',')); } catch (e) { first = null; }
    if (first) {
      L.push('首个卡片 HTML：');
      L.push(String(first.outerHTML || '').replace(/\s+/g, ' ').slice(0, 700));
    }

    L.push('');
    L.push('## 滚动');
    var host = findScrollHost();
    L.push('滚动容器：' + (host ? descEl(host) : '未找到（按整页滚动处理）'));
    L.push('  容器 scrollHeight=' + (host ? host.scrollHeight : 0) +
      ' clientHeight=' + (host ? host.clientHeight : 0));
    var se = document.scrollingElement || document.documentElement;
    L.push('  页面 scrollHeight=' + (se ? se.scrollHeight : 0) +
      ' clientHeight=' + (se ? se.clientHeight : 0));
    L.push('  到底提示：' + (endOfList() || '（没找到「没有更多了」这类文案）'));

    if (/\/web\/geek\/chat/.test(location.pathname)) {
      L.push('');
      L.push('## 聊天页');
      L.push(chatDiagnose());
    }

    L.push('');
    L.push('## 分页 / 加载更多候选');
    var KEY = /(more|load|next|page|pager|pagination)/i;
    var found = 0;
    Array.prototype.forEach.call(document.querySelectorAll('a, button, div, span, li'), function (el) {
      if (found >= 18) return;
      var cls = String(el.getAttribute('class') || '');
      var id = String(el.getAttribute('id') || '');
      if (!KEY.test(cls) && !KEY.test(id)) return;
      if (!isVisible(el)) return;
      L.push('  ' + descEl(el));
      found++;
    });
    if (!found) L.push('  （没有类名/ID 含 more/load/next/page 的可见元素）');

    L.push('');
    L.push('## 详情面板');
    SEL.panel.forEach(function (s) {
      var n = countSel(s);
      var el = null;
      try { el = document.querySelector(s); } catch (e) { el = null; }
      L.push('  ' + s + ' → ' + n + (el && isVisible(el) ? ' 可见' : ' 不可见'));
    });
    var panel = readPanel();
    L.push('readPanel()：' + (panel ? '命中 ' + descEl(panel.el, 40) : '未命中'));
    if (panel) L.push('  文本前 80 字：' + panel.text.slice(0, 80));

    L.push('');
    L.push('## 沟通按钮');
    var cb = findChatButton(document);
    L.push('findChatButton()：' + (cb ? descEl(cb, 12) : '未找到'));

    L.push('');
    L.push('## 页面里的可点元素（前 40 个）');
    var n2 = 0;
    Array.prototype.forEach.call(document.querySelectorAll('a, button, [class*="btn"]'), function (el) {
      if (n2 >= 40) return;
      if (!isVisible(el)) return;
      var mark = insideCard(el) ? ' [卡片内]' : (inDetailPanel(el) ? ' [详情区]' : '');
      L.push('  ' + descEl(el, 14) + mark);
      n2++;
    });
    if (!n2) L.push('  （没有可见的 a / button）');

    return L.join('\n');
  }

  /* ---------------------------------------------------------------- 异常探针 */

  function anomalyNow() {
    return C.anomalyFromLocation(
      (typeof location !== 'undefined' ? location.href : ''),
      (typeof document !== 'undefined' ? document.title : '')
    );
  }

  return {
    SEL: SEL,
    q: q,
    qa: qa,
    txt: txt,
    isVisible: isVisible,
    clickEl: clickEl,
    jobIdFromHref: jobIdFromHref,
    readCard: readCard,
    collectCards: collectCards,
    readPanel: readPanel,
    panelCands: panelCands,
    jdFromHtml: jdFromHtml,
    parseJdHtml: parseJdHtml,
    fetchJd: fetchJd,
    findChatButton: findChatButton,
    isContactedText: isContactedText,
    probePage: probePage,
    findMoreButton: findMoreButton,
    findNextPage: findNextPage,
    findSortLatest: findSortLatest,
    pagerDisabled: pagerDisabled,
    insideCard: insideCard,
    isJobEntry: isJobEntry,
    inDetailPanel: inDetailPanel,
    isOffLimit: isOffLimit,
    findScrollHost: findScrollHost,
    endOfList: endOfList,
    scrollToBottom: scrollToBottom,
    scrollToTop: scrollToTop,
    scrollHeightOf: scrollHeightOf,
    scrollTopOf: scrollTopOf,
    cardClickTarget: cardClickTarget,
    cardClickChain: cardClickChain,
    cardDiag: cardDiag,
    findCardChatButton: findCardChatButton,
    chatInput: chatInput,
    chatSendButton: chatSendButton,
    chatMessageSent: chatMessageSent,
    chatMsgCount: chatMsgCount,
    chatDiagnose: chatDiagnose,
    caretToEnd: caretToEnd,
    pressEnter: pressEnter,
    typeInto: typeInto,
    inputText: inputText,
    inputEmpty: inputEmpty,
    topDialog: topDialog,
    dialogActionFor: dialogActionFor,
    anomalyNow: anomalyNow
  };
});

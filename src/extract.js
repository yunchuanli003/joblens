/* joblens extract — 页面结构与选择器，纯函数，可在 jsdom 中测试
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
   * 否则同一个按钮会触发两次点击（对「只该点一次」的控件是致命的）。
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
    L.push('# joblens 页面诊断');
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
    topDialog: topDialog,
    dialogActionFor: dialogActionFor,
    anomalyNow: anomalyNow
  };
});

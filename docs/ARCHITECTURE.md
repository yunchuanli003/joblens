# 架构与数据流

四层、单向依赖、没有构建步骤。想看「为什么这么切」请看 [DESIGN.md](DESIGN.md)。

## 分层

```mermaid
graph TD
  subgraph page["浏览器页面（zhipin.com，你已登录的会话）"]
    DOM["岗位列表 / 详情面板 / 聊天页 DOM"]
  end

  subgraph cs["内容脚本 content script"]
    EX["extract.js<br/>结构适配层<br/>选择器表 + 多级回退"]
    CO["core.js<br/>规则引擎<br/>薪资解密 · 打分 · 去重键<br/>（纯函数，无 DOM）"]
    CT["content.js<br/>流程状态机<br/>扫描 · 节流 · 熔断 · 记账"]
    UI["Shadow DOM 悬浮面板<br/>日志 · 报告 · 诊断"]
  end

  subgraph ext["扩展其它部分"]
    OPT["options.html/js<br/>画像与节奏配置"]
    POP["popup.html/js<br/>状态 · 诊断 · 报告入口"]
    BG["background.js<br/>安装初始化 · 消息转发"]
  end

  ST[("chrome.storage.local<br/>config · profile<br/>records · stats")]

  DOM -->|"读（只读，扫描阶段零点击）"| EX
  EX -->|"结构化 Job 对象"| CO
  CO -->|"score / level / reasons"| CT
  CT -->|"点击 · 滚动 · 拦截默认跳转"| DOM
  CT --> UI
  CT <--> ST
  CO -.->|读配置| ST
  OPT <--> ST
  POP <--> ST
  BG -.->|首次打开设置页| OPT
```

依赖方向是硬的：`core.js` 不认识 DOM，`extract.js` 不认识业务规则，`content.js` 不认识选择器常量。违反这条的几个具体好处是：

- `core.js` 可以在 Node 里直接单测（221 项，不碰 jsdom）
- 换一个网站（结构完全不同）只需要重写 `extract.js`
- 调打分公式不会碰到任何点击逻辑

## 一次「扫描打分」

```mermaid
sequenceDiagram
  participant U as 用户
  participant CT as content.js
  participant EX as extract.js
  participant CO as core.js
  participant DOM as 页面

  U->>CT: 点「扫描打分」
  CT->>ST: 读 config / profile / records
  CT->>EX: collect()
  EX->>DOM: querySelectorAll(SEL.card)
  EX-->>CT: Job[]（title · company · salary · city · tags）
  CT->>CT: mergeCards()：byId + byTx 双索引去重
  loop 每张卡
    CT->>CO: evaluate(job, profile)
    CO-->>CT: {score, level, reasons}
    CT->>DOM: 卡片右上角画徽章（绿/橙/灰）
  end
  CT->>CT: 统计「依据分布」：未命中偏好词 ×14 …
  U->>CT: 点「报告」
  CT-->>U: 纯文本报告（画像 · 依据 · 推荐/待看/跳过明细）
```

扫描阶段**完全不点击、不滚动到底**（滚动是「换一批」的职责），只读 DOM 并画徽章。

## 投一份的时序

```mermaid
sequenceDiagram
  participant CT as content.js
  participant EX as extract.js
  participant SITE as zhipin.com
  participant CO as core.js

  CT->>CT: 闸门检查（本轮未满 8 · 今日未满 30 · 熔断未触发）
  CT->>EX: fetchJd(job.id)
  EX->>SITE: GET /job_detail/[jobId].html（credentials: include）
  alt 拿到 HTML 且解析出 .job-sec-text
    SITE-->>EX: SSR HTML
    EX->>EX: jdFromHtml()：.job-sec-text → 文本特征兜底
    Note over EX: 完全不点卡片
  else 403 / 安全校验 / 没有 JD 段落
    CT->>EX: openCard(job)：四目标链
    EX->>SITE: 点击容器 → li → 标题 → 详情链接
    EX-->>CT: readPanel()（多候选择优）
  end
  CT->>CT: HR 活跃度复核（卡片 + 详情页；任一条说最近来过就放行）
  alt 明确超期（超过 activity_max_idle_days）
    CT->>CT: 记 stale_hr 跳过，连那 2~5 秒都不等
  end
  CT->>CT: 停留 2~5 秒（读 JD 的节奏）
  CT->>CO: evaluate(job, profile, jdText) 二次打分
  alt 不达阈值
    CT->>CT: 记 skipped，连卡片都不点
  else 达阈值
    CT->>EX: resolveChatButton(job)
    EX-->>CT: 本岗面板按钮 / 卡片按钮 / 点开后的面板按钮
    CT->>SITE: 点击「立即沟通」
    alt 跳进 /web/geek/chat
      CT->>SITE: 写招呼语 + 发送（或交给 BOSS）
      CT->>CT: 三证据验证，通过才 record(applied)
    else 弹窗 / 面板按钮变「继续沟通」
      CT->>CT: 分类弹窗，按类别记账
    end
  end
  CT->>CT: 节流：随机间隔 + ±25% 抖动，每 8 份休息
```

## 三条不变量

这三条是反复修 bug 修出来的，改动时必须守住。

### 1. 只有拿到证据才记账

「点了按钮」不等于「投递成功」。网页版「立即沟通」只是跳到聊天页，一句话都没发出去。所以 `record({ok:true})` 只在这几种情况下发生：

| 证据 | 代码位置 |
|---|---|
| 输入框被清空 / 消息列表出现这句话 / 会话多了一条 | `sendGreetingInChat` |
| 聊天页出现输入框（同时勾了「交给 BOSS」） | `handoffGreeting` |
| 弹窗分类为 `continue` 且点了确认 | `clickAndFinish` |
| 面板按钮文案发生变化 | `clickAndFinish` |

否则记 `greeting_failed` / `unconfirmed` / `no_button`，不占额度，下一轮重试。

### 2. 终止态只增不减

`applied` 与 `already_contacted` 都算终止态：一旦写下，这个岗位不会再进入任何一轮的队列。判定走 `isDone()`，同时查 `id:` 与 `tx:` 两套键。

### 3. 单飞

`State.running` 为真时再点「开始投递」直接返回；`State.busy` 标出「页面正被我们驱动」的时段，此间的 URL 变化不触发「用户切页」熔断。

## 本地存储

全部在 `chrome.storage.local`，四个键：

| 键 | 内容 | 谁写 |
|---|---|---|
| `config` | `limits`（8 / 30 / 滚动轮数 / 面板等待）、`pacing`（间隔、休息、读 JD 停留）、`safety`（熔断阈值、`handoff_greeting`）、`scoring`（阈值、权重）、`puaMap`（薪资字体映射） | 设置页 |
| `profile` | `title_core`、`prefer`、`avoid`、`must_have`、`reject_keywords`、`target_cities`、`min_salary_k`、`activity_max_idle_days`、`experience`、`greeting_template` | 设置页 |
| `records` | 以 `id:<jobId>` 或 `tx:<标题>\|<公司>` 为键，值为 `{title, company, status, ts, ...}` | content.js |
| `stats` | `{date, applied}`，跨天自动归零 | content.js |

没有第五个键，也没有任何出网请求——除了对 `zhipin.com` 本身的同源 `fetch`。

## 测试策略

```
tests/core.test.js      221 项   纯函数：薪资解密、PUA 映射、打分、HR 活跃档位、招呼语、弹窗分类、URL 探针、配置合并、报告格式
tests/extract.test.js   132 项   jsdom：选择器回退、可见性、jobId 解析、按钮查找、点击目标链、聊天页输入框、滚动容器、诊断输出
tests/flow.test.js      115 项   jsdom + 假 chrome API：扫描 → 标注 → 报告 → 投递 → 落库 → 去重 → SPA 跳转 → 换一批 → 发招呼语
tests/ui.test.js         70 项   jsdom：popup 状态、报告面板、诊断面板、设置页回填 / 校验 / 保存 / 节奏档位
```

**为什么没有 E2E（真浏览器 + 真账号）**：因为它不可重复。这类工具 90% 的 bug 是「这个版本的 DOM 和我以为的不一样」，而真实 DOM 每天都在变，拿它做断言等于把测试绑在一个会漂移的目标上。

折中办法是：**用 jsdom 重构出「我以为的 DOM」，再让真实页面来打脸**。每次真机出问题，第一件事是把这个现场写成一条 jsdom 夹具（为什么点不到、面板为什么读到壳），然后修到用例变绿。538 项测试里，几乎每一组都对应一次真机故障。

## 目录

```
joblens/
  manifest.json          MV3，只有 storage 权限 + zhipin.com host 权限
  src/
    core.js              纯逻辑：薪资、解密、打分、招呼语、弹窗分类（无 DOM 依赖）
    extract.js           页面结构假设：选择器表、卡片抽取、按钮/弹窗定位、JD 直读
    content.js           流程与 UI：扫描、投递循环、节奏、熔断、悬浮面板
    background.js        安装初始化 + 消息转发
    popup.html/js        状态面板
    options.html/js      设置与画像
  tests/                 四套测试（core / extract / flow / ui）
  scripts/
    check.mjs            语法 + manifest 引用 + 权限白名单 + 版本一致性
    build.mjs            零依赖打包（dist/unpacked + dist/*.zip）
    make-icons.py        生成扩展图标（纯标准库）
  docs/                  设计 / 架构 / 使用
```

# 架构

## 分层

```
manifest.json          权限与注入范围（storage + 单个 host）
 src/extract.js        结构适配层：DOM → 结构化岗位对象（不认识业务规则）
 src/core.js           规则引擎：打分、解析、报告、城市轮换（不认识 DOM）
 src/content.js        流程层：扫描、换一批、面板、消息（不认识选择器）
 src/background.js     只做安装引导（打开设置页）
 src/popup.{html,js}   状态显示与消息转发（不持有业务逻辑）
 src/options.{html,js} 表单读写与校验
```

单向依赖：`content → extract → (无)`、`content → core → (无)`。`core.js` 在 Node 里可直接 `require`，所以规则层能纯单测；`extract.js` 只依赖传入的 document，所以能拿 jsdom 夹具跑。

## 一次扫描的时序

```
点「扫描打分」
  → 判定当前页是否列表页（pageKind / anomalyNow）
  → collectCards()      读当前 DOM 里的岗位卡
  → 循环：向下滚 0.9 屏 → 等 1.1~2.1 秒 → 再 collect
       直到 没有新卡片 / 达到 max_cards / 滚满 scroll_rounds
  → evaluate() 逐个打分（纯函数）
  → paintBadge() 给每张卡插一个绝对定位的徽章
  → 更新面板统计（岗位 / 推荐 / 跳过）
```

全程没有 `click()`、没有 `dispatchEvent`、没有 `fetch` 到平台接口。滚动是唯一会改变页面的动作，且与真人手动滚动等价。

## 三条不变量

1. **只读**。`content.js` 不含任何点击或输入注入；`extract.js` 不导出「找沟通按钮」类函数。这条不靠配置开关，靠代码里不存在。
2. **分数可解释**。`evaluate()` 必须返回 `reasons[]`，空理由时回落到「综合匹配」。报告里逐条打印命中项。
3. **选择器只在 `extract.js`**。`SEL` 表是唯一入口，每个字段 2~3 级回退；流程层不允许出现类名。

## 存储结构

`chrome.storage.local`，两个键：

```jsonc
{
  "profile": {
    "role_summary": "…", "experience": "3 年",
    "target_cities": ["杭州"], "min_salary_k": 12,
    "activity_max_idle_days": 14,
    "prefer": [], "avoid": [], "must_have": [],
    "title_core": [], "reject_keywords": []
  },
  "config": {
    "limits": { "scroll_rounds": 8, "max_cards": 120, "panel_wait_ms": 3000 },
    "safety": { "auto_start": false },
    "scoring": { "approve_threshold": 62, "review_threshold": 42, "reject_keywords": [] },
    "puaMap": "0123456789"
  }
}
```

没有服务端，没有同步，没有遥测。清空浏览器数据即全部消失。

## 关键实现点

**卡片去重按两套键。** 优先 `jobId`；取不到链接时退到 `标题|公司`。合并时若新卡有 id 而旧记录没有，用 id 覆盖并同时更新两套索引，避免同一岗位在列表里出现两次。

**换一批是四段式降级。** 滚动 → 加载更多 → 下一页 → 换搜索条件。前三段失败才跳转，跳转前把 URL 存进 `buildSearchUrl()` 的结果，加载后靠 `pendingScan` 标记自动补扫。

**诊断优先于猜测。** `probePage()` 把选择器命中数、卡片结构、分页控件、详情区一次性导出。加一条选择器前先看诊断，比反复让用户「重载试试」快得多。

## 测试策略

不写 E2E。真实 DOM 每天在变，断言它等于把测试绑在会漂移的目标上。

反过来做：**每次真机故障先写一条 jsdom 夹具**，再修到用例变绿。四套测试共 310 项：

- `core.test.js` 193 项：纯函数，不需要 DOM
- `extract.test.js` 68 项：喂 HTML 片段，断言抽取结果
- `flow.test.js` 28 项：jsdom 里加载三个模块 + mock chrome，跑完整链路
- `ui.test.js` 21 项：加载 popup/options 页面，断言 id 绑定、回填、校验、保存

CI（`.github/workflows/ci.yml`）在 Node 22 上跑 `npm run verify`：先自检（语法、manifest 引用、权限白名单、版本一致、文档链接），再跑四套测试。

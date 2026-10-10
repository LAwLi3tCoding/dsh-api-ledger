# API Ledger for DSH

[English](#english) · [简体中文](#简体中文) · [中文完整文档](README.zh.md)

**See what this conversation costs, without leaving it.**

API Ledger brings token usage and estimated API spend into DeepSeek Harness: a full conversation report, a settings dashboard, a compact composer total, and a one-line daily total in the sidebar.

![API Ledger feature overview — illustrated sample data](assets/overview.svg)

*Illustrated feature overview with sample data, not a screenshot of a live account.*

## English

### Why use it?

If your workflow involves switching between API routes or opening a separate report to check costs, these are the features to look at:

- **Costs where you work.** Session spend below the composer; today's spend in the sidebar. Click the daily total to open the full settings report.
- **Same model, different prices.** Pricing is keyed by route and model. An official endpoint and a gateway can have different rates without contaminating each other's estimates.
- **Group deliberately.** Routes remain separate by default. Give them the same billing group to combine their reports; a shared key reference never silently combines accounts or implies shared balance.
- **Two currencies, one consistent view.** CNY/USD display selection is remembered and shared across all four views.
- **Make estimates explainable.** Recent calls show their pricing source. Unknown prices stay unpriced rather than looking free, and historical records retain the rates originally used.
- **No separate dashboard service.** Usage capture and preferences live locally in the plugin. It does not read API key values or upload ledger data to a plugin-owned service.

These are concrete workflow benefits, not a claim that other usage plugins lack them. This plugin measures recorded usage and estimates cost; it does not retrieve provider invoices or account balances.

### Four views

| View | What it answers |
| --- | --- |
| Conversation → API Ledger | What has this conversation cost? Recent calls, model costs, token composition and usage trends. |
| Settings → API Ledger | Where does spending go across conversations? Date ranges, today/yesterday comparison and pricing preferences. |
| Below the composer | How much has this session used so far? |
| Sidebar footer | How much have I used today? One line, with a click through to settings. |

![Route pricing explained — sample configuration](assets/pricing.svg)

*Illustration of route-specific pricing. Example gateway rates are arbitrary, not vendor quotes.*

### Install

Requires Node.js 20+ and a compatible DSH installation. Tested with DSH Desktop 2.0.13 / bundled DSH 0.1.5-rc.2. No build step or runtime npm dependencies.

**DSH Desktop — GitHub installation**

```sh
git clone https://github.com/LAwLi3tCoding/dsh-api-ledger.git
cd dsh-api-ledger
node scripts/install.mjs
```

Restart DSH Desktop. Open **Settings → API Ledger**, or the **API Ledger** tab in a conversation. Keep the cloned folder: installation links to it. Update with `git pull`, then restart. Uninstall this linked installation with `node scripts/install.mjs --uninstall`.

**DSH CLI — a CLI-managed profile**

```sh
# From GitHub
dsh plugin --profile web add github:LAwLi3tCoding/dsh-api-ledger

# From npm
dsh plugin --profile web add dsh-api-ledger
```

Replace `web` with your CLI-managed profile. DSH 0.1.5-rc.2 reserves `desktop` for Electron, so `dsh plugin --profile desktop add ...` is rejected. Use the desktop installation above or the desktop marketplace once the listing is merged; marketplace submission is not the same as availability.

### Configure pricing

Open **Settings → API Ledger → Accounts and pricing**. Each account (route) first lists every model it knows about with its current pricing mode, configured prices on top:

- **Edit** loads that model into the form below; **Save route** stores it. The card stays on the model you saved instead of jumping back to the first one.
- **Delete** drops that one model's ledger price, keeping the account name, its group and every other model.
- **Add a model price** clears the form so a model that has never been called can be priced in advance.
- An account can hold any number of models, and the same model is priced separately per account.

| Mode | Behavior |
| --- | --- |
| Price-book estimate | Bind a price book (model → rates, plus an optional schedule). Peak and holidays are judged at request start in the BOOK's own time zone. |
| Custom price estimate | Set currency and prices per million tokens: uncached input, output, cache read and cache write. Zero is valid. |
| Usage only | Record tokens without inventing a cost. The default when nothing is configured. |

**Pricing is decoupled from "is this the vendor's own endpoint".** The bundled book `deepseek-public-2026` (verified **2026-09-21**) covers `deepseek-flash`, `deepseek-v4-flash`, `deepseek-v4-flash-vision-exp` and `deepseek-v4-pro`, and carries a schedule: weekdays 09:00–12:00 and 14:00–18:00 in `Asia/Shanghai` are peak, the listed rates are the off-peak basis, and peak doubles them. Holidays follow the [2026 State Council notice](https://www.gov.cn/zhengce/zhengceku/202511/content_7047091.htm). **Any account can bind it** — including a corporate gateway that does not draw on personal DeepSeek quota; an endpoint recognized as [DeepSeek official](https://api-docs.deepseek.com/quick_start/pricing/) merely binds it by default. Binding a public book estimates at those rates; it does not claim the account is billed that way.

**Schedule**: `Peak-aware` follows the windows above at request time; `Base rates only` always uses the book's listed rates (the old reference-snapshot behaviour). When a book has peak rules but no calendar for the current year, peak-aware calls stay unpriced rather than guessing a calendar.

Official endpoint detection checks the effective URL, including the DeepSeek adapter's launch-environment override. A route's name alone never establishes official pricing. Prices update with plugin releases, not through a live pricing API.

**Custom price books (config layer; no editor in the UI yet)** — add a `tariffs` section to `$DSH_HOME/api-ledger/config.json`:

```json
"tariffs": {
  "acme-gateway": {
    "label": "ACME gateway", "currency": "CNY", "timeZone": "Asia/Shanghai",
    "verifiedAt": "2026-10-01", "source": "https://intranet.example/pricing",
    "peak": { "days": "mon-fri", "windows": ["09:00-12:00"], "multiplier": 1.5 },
    "holidays": { "2026": [["01-01", "01-03"]] },
    "models": { "deepseek-v4-pro": { "inputPerM": 4, "outputPerM": 12, "cacheReadPerM": 0.4 } }
  }
}
```

Defaults: `currency` USD, `timeZone` `Asia/Shanghai`; no `peak` means a flat book; a built-in id is never replaced. Bind with:

```json
"pricing": { "corporate-gateway/deepseek-v4-pro": { "mode": "tariff", "tariff": "deepseek-public-2026", "window": "auto" } }
```

The legacy `{ "mode": "official" }` and `{ "mode": "reference" }` spellings keep working unchanged; saving that model in Settings rewrites them as the equivalent `tariff` binding. Rates already frozen into records are never recalculated.

Names and groups affect the current report presentation. Price edits affect future calls only. Existing custom preferences survive upgrades. Reset/delete removes ledger preferences for that route, not DSH model settings or historical calls. Inactive routes are grouped separately; preference-only routes disappear when removed.

### Accuracy and data boundaries

- CNY/USD is **display conversion**, using fixed `1 CNY = 0.14 USD`; it is not a live exchange rate or a provider's currency settlement rate.
- A call is recorded when it ends and supplies usage. Views refresh every 10 seconds while visible; today follows the client calendar.
- Costs are **estimates**, not invoices, remaining balances, budgets or subscription charges. Partially priced totals include only known costs.
- Historical calls keep original amounts and rates. A warning flags legacy USD numbers possibly labelled as CNY; it does not rewrite them.
- Uncached input and cache tokens are separate buckets. Reasoning tokens are not charged a second time. Adapters must report compatible normalized usage.
- Calls before installation are not imported. Missing usage cannot be reconstructed; the running process shows a missing-usage count. Nested wrappers are deduplicated, but an outer call that fans out to multiple upstream streams can still undercount.
- Preferences are stored in `$DSH_HOME/api-ledger/config.json`; records in `records.jsonl`, with `rollup.json` as a derived summary. Without `DSH_HOME`, use `~/.dsh/api-ledger/`. These local files and credentials are not part of the package. In-memory history is capped at the latest 200,000 records.

### Development

```sh
npm run check
npm test
npm pack --dry-run
```

Tests exercise pricing boundaries, endpoint recognition, immutable historical amounts, configuration conflicts, same-origin writes, stream capture, report periods, bilingual UI and the four display slots. See [issues](https://github.com/LAwLi3tCoding/dsh-api-ledger/issues) for bug reports; share anonymized examples rather than API keys or private session logs.

License: [MIT](LICENSE).

---

## 简体中文

**不用离开会话，就能查看本次对话花了多少钱。**

API 账本把 Token 用量和 API 估算费用放进 DSH：会话完整报告、设置页总览、输入框下方的会话金额，以及左下角的一行今日金额。

### 哪些地方用起来方便？

- **随手查看费用**：不用频繁打开独立报表；会话费用放在输入框下面，今日费用放在侧边栏，点击即可打开设置中的账本。
- **相同模型可以按不同接口计价**：价格按「路由 + 模型」配置，官方接口和企业网关互不混用。
- **分组由使用者决定**：默认按路由分别统计，需要时再设置相同账单分组。不会因为共用凭据引用就自动合并，也不会把展示分组当作共用余额。
- **四处展示同步切换币种**：CNY/USD 选择会保存并同步，避免不同页面各用一种显示币种。
- **能看懂费用怎么来的**：最近调用标明计价来源，未配置单价显示未计价，历史记录保留当时使用的单价。
- **无需部署额外服务**：用量与配置保存在本机，不读取 API Key 的值，也不上传到插件自建的统计服务。

这些是插件的具体使用价值，不代表其他用量插件都不具备相同能力。这里统计的是已记录用量与估算费用，不是供应商账单或账户余额。

### 四处展示

| 位置 | 用途 |
| --- | --- |
| 会话 → API 账本 | 本会话费用、最近调用、模型分布、Token 构成和用量趋势 |
| 设置 → API 账本 | 跨会话报表、周期筛选、今日／昨日对比、账户与计价 |
| 会话输入框下方 | 本会话已用金额 |
| 侧边栏左下角 | 单行今日费用，点击打开账本设置 |

### 安装

需要 Node.js 20+ 和兼容的 DSH。已在 DSH Desktop 2.0.13／内置 DSH 0.1.5-rc.2 验证；插件无需构建，没有运行时 npm 依赖。

**DSH Desktop：从 GitHub 安装**

```sh
git clone https://github.com/LAwLi3tCoding/dsh-api-ledger.git
cd dsh-api-ledger
node scripts/install.mjs
```

重启 DSH 后，打开「设置 → API 账本」或会话的「API 账本」Tab。安装使用本地链接，请保留克隆目录。更新时执行 `git pull` 后重启；卸载该链接安装时执行 `node scripts/install.mjs --uninstall`。

**DSH CLI：安装到 CLI 管理的 profile**

```sh
# GitHub 安装
dsh plugin --profile web add github:LAwLi3tCoding/dsh-api-ledger

# npm 安装
dsh plugin --profile web add dsh-api-ledger
```

将 `web` 换成自己的 CLI profile。DSH 0.1.5-rc.2 的 `desktop` profile 由 Electron 专管，不能直接使用 `dsh plugin --profile desktop add ...`。桌面端请使用上面的安装脚本，或在市场收录完成后通过桌面市场安装；提交 PR 不等于已经上架。

### 配置计价

打开「设置 → API 账本 → 账户与计价」。每个账户（路由）先列出它已知的全部模型和当前计价方式，已单独配置的排在上面：

- 「编辑」把该模型载入下面的表单；改完点「保存此路由」。保存后卡片停在这个模型上，不会跳回第一个。
- 「删除」只清掉该模型在账本里的价格，保留账户名称、分组和其余模型。
- 「新增模型价格」清空表单，直接输入模型 ID 即可给一个还没调用过的模型预先定价。
- 一个账户可以配任意多个模型；同一个模型在不同账户分别配置。

| 方式 | 含义 |
| --- | --- |
| 价目表估算 | 绑定一张价目表（模型 → 单价，外加可选的时段规则），按请求开始时间在该表自己的时区里判断峰谷与节假日 |
| 自定义单价 | 按每百万 Token 填写非缓存输入、输出、缓存读和缓存写价格及币种；允许零价格 |
| 仅记录用量 | 不猜测费用；未配置时的默认方式 |

**计价与「这个账户是不是官方直连」解耦。** 内置价目表 `deepseek-public-2026`（核验日期 **2026-09-21**）覆盖 `deepseek-flash`、`deepseek-v4-flash`、`deepseek-v4-flash-vision-exp`、`deepseek-v4-pro`，并带峰谷规则：工作日（时区 `Asia/Shanghai`）09:00–12:00 与 14:00–18:00 为高峰，表中价格是非高峰基准价，高峰乘 2；节假日按 [2026 年国务院安排](https://www.gov.cn/zhengce/zhengceku/202511/content_7047091.htm)算非高峰。**任何账户都可以绑定它**——包括不消耗个人 DeepSeek 额度的企业网关；被识别为 [DeepSeek 官方直连](https://api-docs.deepseek.com/quick_start/pricing/)的账户只是默认绑定它。绑定公开价目表只表示按该口径估算，不代表该账户实际按此扣费。

**生效方式**：「自动峰谷」随请求时间按上表变化；「仅基准价」固定用表中基准价（等价于原来的参考价快照）。价目表有峰谷规则、但没有当前年份节假日表时，「自动峰谷」记为未定价而不是猜一个。

官方直连按实际 URL 识别，并考虑 DeepSeek 适配器的启动环境覆盖；名称包含 DeepSeek 不代表官方直连。价表随插件版本更新，并非实时拉取。

**自定义价目表（配置层，暂无 UI 编辑器）**：在 `$DSH_HOME/api-ledger/config.json` 加 `tariffs` 段，字段缺省时 `currency` 为 USD、`timeZone` 为 `Asia/Shanghai`，没有 `peak` 即恒定价格，写成内置同名 id 不会覆盖内置表；绑定写在 `pricing` 里：`{ "corporate-gateway/deepseek-v4-pro": { "mode": "tariff", "tariff": "deepseek-public-2026", "window": "auto" } }`。旧写法 `{ "mode": "official" }` / `{ "mode": "reference" }` 继续可用，设置页保存时自动改写成等价绑定，记录中已冻结的单价不变。

名称与分组调整会更新历史报表的展示，修改单价只影响后续调用。已有自定义配置不会被升级覆盖。重置／删除账本配置保留 DSH 模型配置与历史调用。历史及停用路由单独折叠展示；只有账本配置、没有历史和当前模型配置的路由，删除后会从列表消失。

### 统计边界与本地数据

- CNY/USD 是**展示折算**，固定使用 `1 CNY = 0.14 USD`，不是实时汇率，也不是供应商的币种结算比例。
- 调用结束并上报用量后计入；页面可见时每 10 秒刷新。「今日」按客户端本地日历计算。
- 金额是**估算费用**，不是官方账单、余额、预算或订阅扣费。部分调用未计价时，只汇总已知费用。
- 历史金额和原始单价不变。疑似将 USD 数字标成 CNY 的旧记录会显示提示，不自动重算。
- 非缓存输入与缓存 Token 分开计价，推理 Token 不重复累加；适配器需要提供兼容的标准化用量。
- 安装前的调用不补录。缺失用量无法恢复，当前进程会显示缺失次数。嵌套调用会去重，但一个外层调用扇出多个上游流仍可能漏计。
- 配置位于 `$DSH_HOME/api-ledger/config.json`；逐次记录保存在 `records.jsonl`，`rollup.json` 为派生汇总。未设置 `DSH_HOME` 时使用 `~/.dsh/api-ledger/`。这些本地数据及凭据不随插件分发。内存最多保留最近 200,000 条记录。

### 开发与反馈

```sh
npm run check
npm test
npm pack --dry-run
```

测试覆盖计价边界、官方接口识别、历史金额不变、配置冲突、同源写入、流式捕获、报表周期、双语与四处展示。问题请提交到 [Issues](https://github.com/LAwLi3tCoding/dsh-api-ledger/issues)，使用匿名示例，不要上传 API Key 或私人会话日志。

许可证：[MIT](LICENSE)。

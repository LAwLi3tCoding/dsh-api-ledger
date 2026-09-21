# dsh-api-ledger

按 **API 凭据**统计 token 与费用的 DSH 插件。回答两个被官方费用统计合并掉的问题：

1. **哪把 key 花了多少 token、折合多少钱** —— 而不是"一共花了多少"。
2. **不同额度池分别消耗了多少** —— 企业网关的钱是真的，但不从你的 DeepSeek 余额里出；这两笔数永不相加。

## 它解决的具体问题

`dsh-bill` 按 `provider/model` 汇总，界面也做得很完整；但当同一个模型 id 由多条路由提供时，你无法知道**哪把 key 付的钱**，更无法在企业内网端点按公网单价被折算时察觉计价本身就是错的。

本插件把三件事拆开，各管一层：

| 层 | 职责 | 归属 |
| --- | --- | --- |
| 身份 | 哪把 key | DSH 配置：每把 key 一条 provider 路由 |
| 记账 | 花了多少 | 本插件 host 侧（`llm/stream` 捕获 + 落盘 + 折叠） |
| 计价 | 折合多少钱 | 本插件 `lib/pricing.js`，按 `路由/模型` 寻址，可被 `config.json` 覆盖 |

## 关键设计决定

**凭据身份是"引用名"，不是 key 值。** 记录里只写 `apiKeyEnv` 的名字（如 `EXAMPLE_GATEWAY_API_KEY`）。key 值由 credentials 服务在请求时解析，本插件从不读取、复制或落盘它——`tests/records.test.js` 里有一条断言专门守这条线。

**两把 key 能被区分，前提是它们是两条路由。** DSH 只在路由层取凭据，插件无法绕过这一点。配置方式见下。

**计价按 `路由/模型` 而不是按模型 id。** 同一个 `deepseek-v4-flash` 在 DeepSeek 官方端点和企业网关是不同价格；按模型 id 查公共价目表会把内网消耗按公网价折算，得到一个无法对账的数字。

**认不出价格时报"未定价"，绝不报 0。** "不知道多少钱"和"不要钱"是两回事。

**历史不会被改价影响。** 每条记录冻结当时的单价（`base` 字段），改价目表只影响之后的调用。

## 安装

```sh
dsh plugin --profile desktop add ./dsh-api-ledger
dsh --profile desktop --dump-config   # 应出现 # == dsh-api-ledger 层
```

装完需重启 DSH（bundle 行在启动时组装）。打开 **设置 → API 账本**。

卸载：

```sh
dsh plugin --profile desktop remove dsh-api-ledger
```

## 让不同的 key 分开展示

在 `~/.dsh/settings.yaml` 里，把一把 key 写成一条路由；两把 key 就写两条，只有 `apiKeyEnv` 不同：

```yaml
llm-pi-ai:
  providers:
    gateway-main:
      displayName: Example Gateway 主号
      apiKeyEnv: EXAMPLE_GATEWAY_API_KEY
      api: openai-responses
      baseURL: https://gateway.example/v1
      models:
        - id: deepseek-v4-flash
          name: DeepSeek-V41-Flash
          contextWindow: 1000000
          maxTokens: 131072
          reasoningEfforts: { low: low, high: high, max: max }
    gateway-backup:
      displayName: Example Gateway 备用号
      apiKeyEnv: EXAMPLE_GATEWAY_API_KEY_2     # ← 只有这一行不同
      api: openai-responses
      baseURL: https://gateway.example/v1
      models:
        - id: deepseek-v4-flash
          name: DeepSeek-V41-Flash
          contextWindow: 1000000
          maxTokens: 131072
          reasoningEfforts: { low: low, high: high, max: max }
```

**路由名就是账本身份**，改名等于换账本条目。已有大量历史的名称（`deepseek-official`、`exampleGateway`）不要动，新增路由另起名。

## 配置：`$DSH_HOME/api-ledger/config.json`

不需要重启即可生效（读取有 5 秒缓存）：

```json
{
  "pricing": {
    "gateway-main/deepseek-v4-flash": {
      "inputPerM": 0.44, "outputPerM": 1.32, "cacheReadPerM": 0.014,
      "currency": "CNY", "pool": "corporate"
    }
  },
  "pools": {
    "deepseek-official": "personal-deepseek",
    "gateway-main": "corporate",
    "gateway-backup": "corporate"
  }
}
```

- `pricing` 的键是 `路由/模型`，**优先级高于内置价目表**。部分字段的覆盖会被拒绝（而不是半套用），因为半个单价会产生一个谁也对不上的数。
- `pools` 决定每条路由算哪个额度池。**不在表里且没有匹配价目的路由归入 `unknown`**，界面会单独列出，不会被静默并入某个真实池子。
- 完整价目表见 `lib/pricing.js`，金额单位是"每百万 token"。

## 数据

| 路径 | 内容 |
| --- | --- |
| `$DSH_HOME/api-ledger/records.jsonl` | 每次调用一行，只追加，永不重写 |
| `$DSH_HOME/api-ledger/rollup.json` | 折叠后的合计，带文件指纹 |

`rollup.json` 只在指纹仍与 `records.jsonl` 匹配时被信任；外部工具追加过记录后指纹失配，会退化为重新折叠，而不是给出一个错的数。

**历史无法回溯归因。** 安装本插件之前由 `dsh-bill` 记录的历史里没有凭据字段，本插件不做推断——编造归因比留空更糟。因此账本从安装那一刻开始。

## 界面：四个位置，共用一套账本

| 位置 | 展示内容 |
| --- | --- |
| 会话上方「API 账本」tab | 当前会话的分池费用、Token、调用次数、缓存命中、用量趋势和 API 明细 |
| 设置 → API 账本 | 跨会话报告，可选今日、近 7 天、近 30 天、全部历史 |
| 会话输入框下方 | 当前会话已产生的费用，按额度池分列 |
| 左下角侧栏 | 单行显示今日费用，点击打开设置中的 API 账本；多池显示首池及其余池数量，悬停查看各池金额 |

费用卡片按额度池分别展示，不提供跨池合计。趋势图也按池分开绘制。API 明细在宽页面使用表格，在窄页面使用字段卡片；模型明细可展开。同一池内有多个 API 凭据时，提供费用对比和可展开的用量特征雷达图；单凭据不占用雷达区。

设置页默认显示近 30 天。今日按客户端本地午夜计算；近 7 天和近 30 天按当前时刻回溯。趋势图展示所选范围内最近 30 个有记录的日期，不补造无记录日期。

### CNY / USD

默认显示 CNY，页面右上角可切换 CNY / USD；会话底部也提供切换按钮，左下角点击进入设置页切换。四处同步更新，币种选择保存在当前浏览器的本地存储中，刷新后保留。

换算率直接读取后端价目表的 `USD_RATES`，当前为 **1 CNY = 0.14 USD**。这是固定的记账折算率，不是实时外汇牌价。切换币种只改变显示，不重写历史记录或重新计价。未取得换算率时不显示虚构金额；未定价调用单独提示，不当作免费调用。

### 刷新与金额口径

页面可见时每 10 秒读取一次报告，窗口隐藏时暂停取数，恢复可见时立即刷新。读取时重新计算本地午夜，因此跨天后「今日」自动切换。同一范围的并发请求会合并，组件卸载后清除轮询。

金额来自已记录用量和配置单价的估算。一次模型调用结束并上报用量后才计入，不表示正在生成的实时金额，也不表示账户余额或供应商账单。客户端与后端版本不匹配时提示重启，不把旧接口缺失的字段显示为零费用。

图表使用 SVG，不引入图表库。每日图支持悬停查看当日数值；雷达按各轴最大值作平方根归一，缓存命中率保持原始比例。

## 语言：跟随 DSH 的语言设置

中英双语，**切换语言即时生效，无需重启或刷新**。

- 文案只有一份真源：`lib/client.js` 里的 `MESSAGES`，每行是 `[key, zh, en]`。**两种语言写在同一行**，所以"某个 key 只存在于一种语言"这件事无法表达——locale 服务在注册时强制双语平衡并直接抛错，而那种失败只会在浏览器里暴露。`tests/i18n.test.js` 覆盖结构保证不了的部分：空值、重复 key、占位符只在一种语言里、以及 `t('…')` 引用了不存在的 key（那会静默渲染成原始 key，看起来像样式问题）。
- **nav 标签用 thunk**：`label: () => t('view.title')`。Slot 契约规定 thunk 每次投影都重读，因此语言变化自动反映，**不需要重新注册**。
- **页面正文用 `useSyncExternalStore` 订阅 locale 服务**（已确认运行时 React 18.3.1 提供该 API）：`register()` 只让字典可用，已经渲染过的组件不会自己重渲染，必须依靠 `revision` 变化的通知。
- locale 服务是**可选探测**：它不存在时页面仍以中文渲染，而不是白屏。

## 已知边界

- **嵌套包装路由会被去重。** `llm/stream` 是瀑布：包装路由在自身 `stream()` 里再次调用 `ctx.llm.stream()` 时，整条瀑布会重入。本插件用 `AsyncLocalStorage` 标记已记账的异步上下文，usage 只记一次。扇出型路由（单次 pull 派生多条上游流）会被误判为嵌套而漏记 —— 出现这类路由需要改成按流实例标记。
- **未上报 usage 的调用会被单独计数并在页脚说明**，不计入合计，避免总量看起来完整而实际缺失。
- **峰谷档位按请求发起时刻判定**，不按完成时刻：一次跨整点的流式调用若按完成时刻归档，会被算进另一个档位。
- **消费方中断流时显式传播 `iterator.return()`**，否则上游 HTTP 流会跑完而无人读取 usage，供应商照常计费。

## 开发

```sh
npm run check   # 语法检查
npm test        # 价目表、身份、记账、语言、统计范围、四处展示与刷新行为回归
```

`tests/report.test.js` 不是纯函数测试：它挂载**真实的插件**（桩掉 Cordis 上下文与 `connection`/`webServer` 服务），并像客户端那样驱动 `report`。其中一项专门锁死载荷路径——客户端读的是 `totals.byIdentity` / `totals.byPool` / `totals.byDay` / `totals.byModel`，一旦两侧改名，页面会把图表画成空的却依然长得像正常页面，这是最难靠肉眼发现的失败。

## 许可

MIT

### 报告展示

- 会话页优先展示最近调用；设置页在额度池卡片中显示今日与昨日金额，昨日没有记录时明确提示。昨日边界使用浏览器的本地日历，支持夏令时。
- 最近调用最多 15 条，默认展示 5 条，其余可展开；按调用开始时间排序，仅包含当前会话或所选周期。
- 模型费用分布按额度池分别展示，仅计算已计价费用占比。单日记录使用紧凑用量构成，多日记录展示趋势。
- 缓存命中率为缓存读取 /（非缓存输入 + 缓存读取），不含缓存写入。全局缺失用量提示包含本次运行中未上报用量的调用。

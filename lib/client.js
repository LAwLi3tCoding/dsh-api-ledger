/**
 * API ledger UI: settings report, session report, composer spend, sidebar today.
 * Billing pools stay separate. Display currency changes formatting only.
 * Read-only reports use the Connection RPC channel, with an HTTP fallback.
 */

window.__ModuleLoader__.load({
  id: 'dsh-api-ledger',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    var React = require('react')

    var SERIES = ['#3b82f6', '#f59e0b', '#10b981', '#ef4444', '#8b5cf6', '#06b6d4', '#ec4899']
    var COST_COLOR = '#8b5cf6'
    var POOL_ORDER = ['personal-deepseek', 'corporate', 'third-party', 'unknown']
    var POOL_COLOR = {
      'personal-deepseek': '#3b82f6',
      'corporate': '#f59e0b',
      'third-party': '#10b981',
      'unknown': '#8b949e',
    }

    // Colours come from the harness theme variables where one exists, so the
    // page follows light/dark and any user theme. Series colours are fixed
    // because they must stay distinguishable and stable across renders.
    var C = {
      text: 'var(--dsw-alias-label-primary, #1f2328)',
      dim: 'var(--dsw-alias-label-secondary, #656d76)',
      faint: 'var(--dsw-alias-label-tertiary, #656d76)',
      border: 'var(--dsw-alias-border-l3, #d8dee4)',
      rule: 'var(--dsw-alias-border-l1, #eaeef2)',
      card: 'var(--dsw-alias-interactive-bg-hover, #f6f8fa)',
      err: 'var(--dsw-alias-state-error-primary, #d1242f)',
    }

    var S = {
      // Both slots are column layouts. The frame owns the available width and
      // insets; its child report never sizes itself from table/SVG contents.
      page: {
        color: C.text, fontSize: 13, lineHeight: 1.5, paddingBottom: 12,
        boxSizing: 'border-box', maxWidth: '100%', minWidth: 0,
      },
      head: { display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap', minWidth: 0 },
      h1: { fontSize: 18, fontWeight: 650, margin: 0, letterSpacing: '-0.01em' },
      sub: { color: C.faint, fontSize: 12, margin: '4px 0 0' },
      sec: { marginTop: 16, minWidth: 0 },
      secHead: { display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap', marginBottom: 10, minWidth: 0 },
      secTitle: { fontSize: 13, fontWeight: 600, margin: 0 },
      secNote: { color: C.faint, fontSize: 11, textAlign: 'right' },
      card: {
        border: '1px solid ' + C.border, borderRadius: 10, background: 'transparent',
        padding: '12px 14px', boxSizing: 'border-box', minWidth: 0, maxWidth: '100%',
      },
      grid: { display: 'grid', gap: 10, minWidth: 0 },
      kpiValue: { fontSize: 22, fontWeight: 650, fontVariantNumeric: 'tabular-nums', letterSpacing: '-0.02em', lineHeight: 1.2 },
      kpiLabel: { color: C.dim, fontSize: 11, fontWeight: 500 },
      kpiSub: { color: C.faint, fontSize: 11, marginTop: 2 },
      barTrack: { height: 6, borderRadius: 3, background: C.rule, overflow: 'hidden', marginTop: 8 },
      barFill: { height: '100%', borderRadius: 3 },
      scroll: { minWidth: 0, maxWidth: '100%', overflowX: 'auto', overflowY: 'hidden' },
      table: { width: '100%', tableLayout: 'fixed', borderCollapse: 'collapse', fontSize: 12 },
      th: { textAlign: 'left', fontWeight: 500, color: C.dim, padding: '6px 7px', borderBottom: '1px solid ' + C.border, whiteSpace: 'nowrap', fontSize: 11, overflow: 'hidden', textOverflow: 'ellipsis' },
      thNum: { textAlign: 'right' },
      td: { padding: '6px 7px', borderBottom: '1px solid ' + C.rule, verticalAlign: 'middle', overflow: 'hidden', textOverflow: 'ellipsis' },
      tdNum: { textAlign: 'right', fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' },
      name: { fontWeight: 550, maxWidth: 170, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
      routeLine: { color: C.faint, fontSize: 11, maxWidth: 170, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
      swatch: { width: 9, height: 9, borderRadius: 3, display: 'inline-block', flexShrink: 0 },
      lineSwatch: { width: 14, height: 2, borderRadius: 1, display: 'inline-block', flexShrink: 0 },
      // Flexible rather than a rigid 46px: inside a `table-layout: fixed`
      // column, a fixed bar beside its percentage label would overflow the cell.
      miniTrack: { height: 4, borderRadius: 2, background: C.rule, overflow: 'hidden', flex: '1 1 0', minWidth: 0 },
      row: { display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 },
      muted: { color: C.dim, fontSize: 12 },
      faintText: { color: C.faint, fontSize: 11 },
      empty: { color: C.faint, fontSize: 12, padding: '14px 0', textAlign: 'center' },
      chip: { display: 'inline-flex', alignItems: 'center', gap: 5, padding: '2px 7px', borderRadius: 999, border: '1px solid ' + C.border, fontSize: 11, color: C.dim },
      legend: { display: 'flex', gap: 14, flexWrap: 'wrap', marginTop: 10 },
    }

    // Use the slot's width, not the window's: settings is a narrow modal even
    // on a large desktop. Keep all rules local to this plugin.
    var LAYOUT_CSS = `
      .api-ledger-frame { box-sizing: border-box; width: 100%; min-width: 0;
        container: api-ledger / inline-size; font-family: var(--dsw-font-family, system-ui); }
      .api-ledger-frame--session { padding: 16px clamp(16px, 3%, 32px) 24px; }
      .api-ledger-report { width: 100%; max-width: 1080px; margin-inline: auto; overflow-wrap: anywhere; }
      .api-ledger-table td:first-child > div { max-width: 100% !important; }
      .api-ledger-table td:first-child div[title] { max-width: 100% !important; }
      @container api-ledger (max-width: 720px) {
        .api-ledger-table, .api-ledger-table tbody { display: block; }
        .api-ledger-table thead { position: absolute; width: 1px; height: 1px;
          clip-path: inset(50%); overflow: hidden; white-space: nowrap; }
        .api-ledger-table tbody tr { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr));
          gap: 14px 12px; padding: 16px 0; background: transparent !important; }
        .api-ledger-table tbody tr + tr { border-top: 1px solid ${C.border}; }
        .api-ledger-table tbody tr:first-child { padding-top: 2px; }
        .api-ledger-table tbody tr:last-child { padding-bottom: 2px; }
        .api-ledger-table td { display: block; min-width: 0; padding: 0 !important;
          border: 0 !important; text-align: left !important; white-space: normal !important; overflow: visible !important; }
        .api-ledger-table td::before { content: attr(data-label); display: block;
          font-size: 11px; font-weight: 400; color: ${C.dim}; margin-bottom: 3px; }
        .api-ledger-table td:first-child { grid-column: 1 / -1; padding-bottom: 10px !important;
          border-bottom: 1px solid ${C.rule} !important; }
        .api-ledger-table td:first-child::before { display: none; }
        .api-ledger-table td:first-child div[title] { white-space: normal !important; overflow-wrap: anywhere; }
        .api-ledger-table td[data-pool] { grid-column: 1 / -1; }
      }
      @container api-ledger (max-width: 360px) {
        .api-ledger-table tbody tr { grid-template-columns: repeat(2, minmax(0, 1fr)); }
      }
      .api-ledger-frame { --ledger-accent: var(--dsw-alias-state-business-primary, #4168d4); }
      .api-ledger-header { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; flex-wrap: wrap; }
      .api-ledger-eyebrow { color: var(--dsw-alias-label-tertiary, #656d76); font-size: 11px; margin-bottom: 6px; letter-spacing: .04em; }
      .api-ledger-header h2 { font-size: 24px !important; font-weight: 600 !important; letter-spacing: -.025em; }
      .api-ledger-toolbar { display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; margin-top: 12px; padding-bottom: 12px; border-bottom: 1px solid var(--dsw-alias-border-l2, #ddd); }
      .api-ledger-segment { display: inline-flex; flex-shrink: 0; padding: 3px; gap: 2px; border-radius: 9px; background: var(--dsw-alias-interactive-bg-hover, #f2f4f8); }
      .api-ledger-segment button, .api-ledger-toolbar select { font: inherit; font-size: 12px; color: var(--dsw-alias-label-secondary, #656d76); border: 0; border-radius: 6px; background: transparent; padding: 6px 10px; cursor: pointer; }
      .api-ledger-segment button[aria-pressed=true] { background: var(--dsw-alias-bg-base, white); color: var(--dsw-alias-label-primary, #1f2328); box-shadow: 0 1px 3px #00000014; font-weight: 600; }
      .api-ledger-toolbar select { background: var(--dsw-alias-interactive-bg-hover, #f2f4f8); color: var(--dsw-alias-label-primary, #1f2328); }
      .api-ledger-frame button:focus-visible, .api-ledger-frame select:focus-visible, .api-ledger-disclosure summary:focus-visible, .api-ledger-status button:focus-visible { outline: 2px solid var(--dsw-alias-state-business-primary, #4168d4); outline-offset: 3px; }
      .api-ledger-pools { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 220px), 1fr)); gap: 12px; }
      .api-ledger-pool { border: 1px solid var(--dsw-alias-border-l2, #ddd); border-radius: 12px; padding: 12px 16px; min-width: 0; position: relative; overflow: hidden; }
      .api-ledger-pool::before { content: ''; position: absolute; inset: 16px auto 16px 0; width: 3px; background: var(--pool-color); border-radius: 0 3px 3px 0; }
      .api-ledger-pool-label { font-size: 12px; font-weight: 500; color: var(--dsw-alias-label-secondary, #656d76); }
      .api-ledger-amount { font-family: var(--dsw-font-family, system-ui); font-size: 30px; line-height: 1.25; letter-spacing: -.03em; font-weight: 600; font-variant-numeric: tabular-nums; margin: 6px 0 8px; overflow-wrap: anywhere; }
      .api-ledger-metrics { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 16px; margin: 14px 0 0; padding: 0 0 14px; border-bottom: 1px solid var(--dsw-alias-border-l2, #ddd); }
      .api-ledger-metrics dt { font-size: 11px; color: var(--dsw-alias-label-secondary, #656d76); }
      .api-ledger-metrics dd { margin: 4px 0 0; font-size: 17px; font-variant-numeric: tabular-nums; font-weight: 550; }
      .api-ledger-charts { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 420px), 1fr)); gap: 12px; }
      .api-ledger-chart svg { max-height: 220px; }
      .api-ledger-recent { list-style: none; padding: 0; margin: 0; }
      .api-ledger-recent li { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 4px 14px; padding: 10px 0; border-bottom: 1px solid ${C.rule}; }
      .api-ledger-recent small { display: block; font-size: 11px; color: ${C.dim}; }
      .api-ledger-recent strong { font-variant-numeric: tabular-nums; font-weight: 550; }
      .api-ledger-breakdown { display: flex; flex-wrap: wrap; gap: 10px 20px; font-size: 12px; }
      .api-ledger-breakdown span { color: ${C.dim}; }
      .api-ledger-comparison { margin-top: 8px; font-size: 11px; color: ${C.dim}; }

      .api-ledger-pool-heading { font-size: 12px; font-weight: 550; margin: 0 0 14px; }
      .api-ledger-detail + .api-ledger-detail { margin-top: 12px; }
      .api-ledger-disclosure { margin-top: 14px; padding-top: 12px; border-top: 1px solid var(--dsw-alias-border-l1, #eee); }
      .api-ledger-disclosure summary { color: var(--dsw-alias-label-secondary, #656d76); cursor: pointer; font-size: 12px; padding: 2px 0; }
      .api-ledger-disclosure[open] summary { margin-bottom: 14px; }
      .api-ledger-footnote { font-size: 11px; color: var(--dsw-alias-label-tertiary, #656d76); margin-top: 22px; }
      .api-ledger-footnote p { margin: 4px 0; }
      .api-ledger-warning { color: var(--dsw-alias-state-warning-primary, #ad6b16); font-size: 11px; }
      .api-ledger-status { display: flex; align-items: baseline; justify-content: center; flex-wrap: wrap; gap: 4px 10px; padding: 2px 16px 6px; font-size: 11px; line-height: 18px; color: var(--dsw-alias-label-secondary, #656d76); }
      .api-ledger-status-pool { display: inline-flex; gap: 5px; min-width: 0; overflow-wrap: anywhere; }
      .api-ledger-status strong { color: var(--dsw-alias-label-primary, #1f2328); font-weight: 550; font-variant-numeric: tabular-nums; }
      .api-ledger-status button { font: inherit; font-size: 10px; color: inherit; cursor: pointer; border: 1px solid var(--dsw-alias-border-l2, #ddd); border-radius: 5px; background: transparent; padding: 0 4px; }
      .api-ledger-status--sidebar { font-family: inherit; width: 100%; box-sizing: border-box; border: 0; cursor: pointer; justify-content: flex-start; align-items: center; flex-wrap: nowrap; gap: 6px; white-space: nowrap; padding: 8px 10px; margin-bottom: 4px; border-radius: 10px; background: transparent; }
      .api-ledger-status--sidebar:hover { background: var(--dsw-alias-interactive-bg-hover, #f2f4f8); }
      .api-ledger-status--sidebar:focus-visible { outline: 2px solid var(--dsw-alias-state-business-primary, #4168d4); outline-offset: -2px; }
      .api-ledger-status--sidebar .api-ledger-status-label { flex-shrink: 0; }
      .api-ledger-status--sidebar .api-ledger-status-pool { overflow: hidden; white-space: nowrap; }
      .api-ledger-status--sidebar .api-ledger-status-pool > span { overflow: hidden; text-overflow: ellipsis; }
      .api-ledger-status--sidebar strong { flex-shrink: 0; }
      .api-ledger-status-arrow { margin-left: auto; flex-shrink: 0; }
      .api-ledger-status--sidebar[data-rail=true] { justify-content: center; padding: 8px; font-size: 14px; }
      @container api-ledger (max-width: 420px) {
        .api-ledger-metrics { grid-template-columns: repeat(2, minmax(0, 1fr)); }
      }
    `

    function ReportFrame(props) {
      return React.createElement('div', { className: 'api-ledger-frame' + (props.session ? ' api-ledger-frame--session' : '') },
        React.createElement('div', { className: 'api-ledger-report' }, props.children))
    }

    // ── i18n ─────────────────────────────────────────────────────────────────

    /**
     * Messages as `[key, zh, en]` rows — ONE row per message, both languages
     * together.
     *
     * The shape is the point. The locale service enforces bilingual balance at
     * registration and throws otherwise, which is a failure you would only see
     * in a browser; keeping both languages in the same row makes "this key
     * exists in one language only" unrepresentable rather than merely tested.
     * `tests/i18n.test.js` still checks what the shape cannot: empty values, a
     * duplicated key, a `{placeholder}` present in one language but not the
     * other, and a `t(...)` call naming a key that does not exist.
     */
    var MESSAGES = [
      ['report.title', '费用与用量', 'Cost & usage'],
      ['report.subtitle', '按额度池查看已记录的估算费用。', 'Estimated spend from recorded usage, by billing pool.'],
      ['report.recent', '最近调用', 'Recent calls'],
      ['report.moreCalls', '展开其余调用', 'Show remaining calls'],
      ['report.recentNote', '最近 15 次 · 按开始时间排序', 'Latest 15 · sorted by start time'],
      ['report.distribution', '模型费用分布', 'Cost by model'],
      ['report.known', '仅含已计价费用', 'Priced usage only'],
      ['report.compare', '今日 {today} · 昨日 {yesterday}', 'Today {today} · yesterday {yesterday}'],
      ['report.noYesterday', '无记录', 'No records'],
      ['report.noClock', '不可用', 'Unavailable'],
      ['report.singleDay', '单日记录 · 用量构成', 'One recorded day · token breakdown'],
      ['report.cacheBasis', '缓存读取 /（非缓存输入 + 缓存读取）；不含缓存写入', 'Cache reads / (uncached input + cache reads); excludes cache writes'],
      ['report.sessionSub', '本会话的调用记录、模型分布与估算费用。', 'Calls, model breakdown and estimated spend for this session.'],
      ['report.session', '本会话费用', 'Session spend'],
      ['report.all', '全部历史', 'All time'],
      ['report.live', '每 10 秒更新 · 调用结束后计入', 'Updates every 10s · recorded after each call'],
      ['report.pools', '按额度池分别计费', 'Spend by billing pool'],
      ['report.trend', '用量趋势', 'Usage trend'],
      ['report.details', 'API 与模型明细', 'API & model details'],
      ['report.models', '模型明细', 'Model details'],
      ['report.calls', '调用次数', 'Calls'],
      ['report.apis', 'API 凭据', 'API credentials'],
      ['report.range', '统计周期', 'Reporting period'],
      ['report.empty', '该范围内暂无调用。下一次调用完成后会自动显示。', 'No calls in this period. Completed calls will appear automatically.'],
      ['report.basis', '按已记录用量与配置单价估算，不代表账户余额或供应商账单。', 'Estimated from recorded usage and configured prices, not a balance or provider invoice.'],
      ['report.fx', '固定折算：1 CNY = {rate} USD；仅切换展示，不改历史计价。', 'Fixed conversion: 1 CNY = {rate} USD; historical pricing stays unchanged.'],
      ['report.fxMissing', '未取得 CNY 换算率，金额暂不可用。', 'CNY conversion rate unavailable. Amounts cannot be displayed.'],
      ['report.persist', '部分记录未能写入磁盘，重启后可能丢失。', 'Some records could not be saved and may be lost after restart.'],
      ['report.missing', '有 {count} 次调用未上报用量（全局记录及本次运行），费用可能不完整。', '{count} calls did not report usage; costs may be incomplete.'],
      ['report.dayLimit', '最多 30 个有记录的日期', 'Up to 30 recorded dates'],
      ['currency.label', '显示币种', 'Display currency'],
      ['currency.toggle', '切换 CNY / USD', 'Switch CNY / USD'],
      ['money.unpriced', '未定价', 'Unpriced'],
      ['money.partial', '另有 {count} 次未定价', '{count} more calls unpriced'],
      ['dock.title', '本会话已用', 'Session spend'],
      ['sidebar.title', '今日已用', 'Today’s spend'],
      ['sidebar.open', '打开设置中的 API 账本', 'Open API Ledger in Settings'],
      ['sidebar.more', '+{count} 池', '+{count} pools'],
      ['compact.empty', '暂无消耗', 'No spend yet'],
      ['compact.error', '费用暂不可用', 'Spend unavailable'],
      ['pool.official', '官方', 'Official'],
      ['pool.corporate', '公司', 'Corporate'],
      ['pool.thirdParty', '第三方', 'Third-party'],
      ['pool.unknown', '未归类', 'Unclassified'],
      ['page.title', 'API 账本', 'API Ledger'],
      ['page.subtitle', '按 API 凭据统计 token 与费用。不同额度池分别列示，不合并计算。', 'Tokens and cost per API credential. Quota pools are listed separately and never summed.'],
      ['chip.records', '{count} 条记录', '{count} records'],

      ['state.loading', '加载中…', 'Loading…'],
      ['state.error', '取数失败：{message}', 'Failed to load: {message}'],
      ['state.restart', '账本后端尚未更新，请重启 DSH。', 'The ledger host is out of date. Restart DSH.'],
      ['state.empty', '尚无调用记录', 'No calls recorded yet'],
      ['state.emptyDays', '暂无每日数据', 'No daily data yet'],
      ['state.emptyTokens', '暂无 token 数据', 'No token data yet'],
      ['state.emptyRadar', '暂无可对比的 API', 'No APIs to compare yet'],
      ['state.emptyCost', '暂无费用数据', 'No cost data yet'],
      ['state.noSession', '请先选择一个会话。', 'Select a conversation first.'],

      ['sec.overview', '概览', 'Overview'],
      ['sec.overview.note', 'USD', 'USD'],
      ['sec.pools', '额度池', 'Quota pools'],
      ['sec.pools.note', '各池独立核算，不相加', 'Each pool is accounted separately and never summed'],
      ['sec.compare', '按 API 对比', 'Comparison by API'],
      ['sec.compare.note', '费用排名', 'Ranked by cost'],
      ['sec.detail', '按 API 明细', 'Detail by API'],
      ['sec.daily', '每日用量与费用', 'Daily tokens and cost'],
      ['sec.daily.note', '近 30 天 · 柱为 token，线为费用', 'Last 30 days · bars are tokens, line is cost'],
      ['sec.radar', '用量特征', 'Usage profile'],
      ['sec.radar.note', '形状对比', 'Shape comparison'],
      ['sec.model', '分模型', 'By model'],
      ['sec.model.note', '按费用排序', 'Sorted by cost'],
      ['sec.sessionApis', '本会话按 API', 'This session by API'],

      ['kpi.total', '累计费用', 'Total cost'],
      ['kpi.tokens', '累计 Token', 'Total tokens'],
      ['kpi.tokens.sub', '含缓存读与缓存写', 'Includes cache read and write'],
      ['kpi.today', '今日', 'Today'],
      ['kpi.week', '近 7 天', 'Last 7 days'],
      ['kpi.month', '近 30 天', 'Last 30 days'],
      ['kpi.calls', '{calls} 次调用', '{calls} calls'],

      ['pool.share', '占总费用 {pct}', '{pct} of total cost'],
      ['pool.sub', '{calls} 次调用 · {tokens} tok', '{calls} calls · {tokens} tok'],

      ['col.credential', '凭据', 'Credential'],
      ['col.pool', '额度池', 'Pool'],
      ['col.calls', '调用', 'Calls'],
      ['col.input', '输入', 'In'],
      ['col.cacheRead', '缓存读', 'Cache'],
      ['col.output', '输出', 'Out'],
      ['col.cost', '费用', 'Cost'],
      ['col.cacheHit', '缓存命中', 'Cache hit'],
      ['col.routeModel', '路由 / 模型', 'Route / model'],
      ['col.unitCost', '单次成本', 'Cost / call'],
      ['col.share', '占比', 'Share'],

      ['band.input', '输入与缓存写', 'Input & cache write'],
      ['band.cacheRead', '缓存读', 'Cache read'],
      ['band.output', '输出', 'Output'],
      ['band.cost', '每日费用（右轴）', 'Daily cost (right axis)'],
      ['band.hoverHint', '悬停柱体查看精确数值与当日费用', 'Hover a bar for exact values and that day cost'],

      ['tag.noKeyRef', '未声明凭据引用', 'no credential reference'],

      ['axis.calls', '调用量', 'Calls'],
      ['axis.tokens', 'Token 量', 'Tokens'],
      ['axis.cost', '费用', 'Cost'],
      ['axis.cache', '缓存命中', 'Cache hit'],
      ['axis.unit', '单次成本', 'Cost / call'],
      ['radar.max', '最大 {value}', 'max {value}'],
      ['radar.note', '各轴按 √(值/该轴最大值) 归一，以压缩量级差异；各轴标签下方标注该轴最大值。缓存命中率本身即比例，不做变换。', 'Each axis is normalized as sqrt(value / axis max) to compress the range; the max is printed under each label. Cache hit rate is already a ratio and is left untransformed.'],
      ['radar.single', '仅一个凭据时不画雷达：各轴只能归一到自身，形状必然是满半径正五边形。', 'Radar omitted with a single credential: every axis would normalize to itself.'],
      ['session.hint', '以上仅本会话。全部历史与跨会话对比见 设置 → API 账本', 'This session only. Full history across sessions: Settings → API Ledger'],

      ['tip.day', '{day}\n输入与缓存写 {input} · 缓存读 {cache} · 输出 {output}\n合计 {tokens} tok\n费用 {cost} · {calls} 次调用', '{day}\nInput & cache write {input} · Cache {cache} · Out {output}\nTotal {tokens} tok\nCost {cost} · {calls} calls'],
      ['tip.radar', '{name}\n调用 {calls} · 费用 {cost}\n单次 {unit}', '{name}\nCalls {calls} · Cost {cost}\nPer call {unit}'],

      ['session.title', '本会话', 'This session'],
      ['session.badge', 'API 账本', 'API Ledger'],
      ['session.sub', '{calls} 次调用 · {tokens} tok', '{calls} calls · {tokens} tok'],
      ['session.poolSub', '{calls} 次', '{calls} calls'],
      ['session.noRecords', '本会话暂无记录', 'No calls in this session yet'],
      ['session.row', '{calls} 次 · {tokens} tok', '{calls} calls · {tokens} tok'],
      ['session.rowHit', '{calls} 次 · {tokens} tok · 命中 {hit}', '{calls} calls · {tokens} tok · {hit} hit'],
      ['aria.daily', '每日 token 与费用图', 'Daily tokens and cost chart'],
      ['aria.radar', '各 API 用量特征雷达图', 'Usage profile across APIs'],

      ['foot.totals', '累计 {calls} 次调用', '{calls} calls total'],
      ['foot.unpriced', ' · {count} 次未定价', ' · {count} unpriced'],
      ['foot.missing', ' · {count} 次未上报用量', ' · {count} without usage'],
      ['foot.source', ' · 数据源 {source}', ' · source {source}'],
    ]

    /** The namespace these messages register under. */
    var NS = 'api-ledger'

    /**
     * Turn {@link MESSAGES} into the `{ zh, en }` pair the locale service wants.
     *
     * No filesystem, no `__dirname`, no dynamic evaluation: the browser module
     * factory injects only `require`, so a bundle that reached for Node builtins
     * would silently fall back to rendering raw keys.
     */
    function buildDicts() {
      var zh = {}
      var en = {}
      for (var i = 0; i < MESSAGES.length; i++) {
        zh[MESSAGES[i][0]] = MESSAGES[i][1]
        en[MESSAGES[i][0]] = MESSAGES[i][2]
      }
      return { NS: NS, zh: zh, en: en }
    }

    /** Pick the dictionary for one locale, falling back to Chinese. */
    function dictFor(dicts, localeId) {
      if (dicts === null || dicts === undefined) return null
      if (typeof localeId === 'string' && dicts[localeId] !== undefined && dicts[localeId] !== null) {
        return dicts[localeId]
      }
      return dicts.zh || null
    }

    /**
     * Translate, with `{name}` interpolation.
     *
     * An unknown key returns the key itself: a visibly wrong label is easier to
     * report than a silently empty one.
     */
    function makeT(dicts, localeId) {
      var table = dictFor(dicts, localeId)
      return function t(key, params) {
        var text = table !== null && typeof table[key] === 'string' ? table[key] : key
        if (params === undefined || params === null) return text
        return text.replace(/\{(\w+)\}/g, function (match, name) {
          return Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : match
        })
      }
    }

    /**
     * Translator bound to the LIVE locale, re-rendering its component on change.
     *
     * `register()` alone is not enough: it makes the dictionaries available, but
     * a component that already rendered keeps its old strings until something
     * re-renders it. `getSnapshot` carries a `revision` that ticks on a locale
     * switch, which is exactly the signal `useSyncExternalStore` needs.
     */
    function useT(dicts) {
      var locale = React.useContext(LocaleContext)
      // A stable face for `useSyncExternalStore`, whether or not the locale
      // service exists. Memoized on `locale` so the subscription is not torn
      // down and rebuilt on every render.
      var face = React.useMemo(function () {
        if (locale === null) {
          return {
            subscribe: function () { return function () {} },
            // A constant `null` is a stable snapshot, which is what the hook
            // requires when nothing can change.
            getSnapshot: function () { return null },
          }
        }
        return {
          subscribe: function (notify) { return locale.subscribe(notify) },
          getSnapshot: function () { return locale.getSnapshot() },
        }
      }, [locale])
      // Called unconditionally. An early return for the no-locale case would
      // skip this hook, and a later render that did have a service would then
      // change the hook count, which React rejects.
      var snapshot = React.useSyncExternalStore(face.subscribe, face.getSnapshot, face.getSnapshot)
      return makeT(dicts, snapshot === null || snapshot === undefined ? null : snapshot.active)
    }

    // ── formatting ───────────────────────────────────────────────────────────

    function num(value) {
      var n = Number(value)
      return Number.isFinite(n) ? n : 0
    }

    /** Token counts, abbreviated. Exactness belongs in a table, not a label. */
    function fmtTok(value) {
      var n = num(value)
      if (n < 1000) return String(Math.round(n))
      if (n < 1e6) return (Math.round(n / 100) / 10) + 'K'
      if (n < 1e9) return (Math.round(n / 1e5) / 10) + 'M'
      return (Math.round(n / 1e8) / 10) + 'B'
    }

    /** Thousands separators, written out rather than via toLocaleString. */
    function fmtInt(value) {
      var n = Math.round(num(value))
      var s = String(Math.abs(n))
      var out = ''
      for (var i = 0; i < s.length; i++) {
        if (i > 0 && (s.length - i) % 3 === 0) out += ','
        out += s[i]
      }
      return (n < 0 ? '-' : '') + out
    }

    var currencyKey = 'dsh-api-ledger.currency'
    var currency = 'CNY'
    try { if (window.localStorage.getItem(currencyKey) === 'USD') currency = 'USD' } catch (_) {}
    var currencyListeners = new Set()
    function getCurrency() { return currency }
    function subscribeCurrency(listener) { currencyListeners.add(listener); return function () { currencyListeners.delete(listener) } }
    function setCurrency(value) {
      if (value !== 'CNY' && value !== 'USD') return
      currency = value
      try { window.localStorage.setItem(currencyKey, value) } catch (_) {}
      currencyListeners.forEach(function (listener) { listener() })
    }
    function useCurrency() { return React.useSyncExternalStore(subscribeCurrency, getCurrency, getCurrency) }
    var MoneyContext = React.createContext({ USD: 1 })
    function formatMoney(usd, unit, rates) {
      var rate = rates && rates[unit]
      if (!(rate > 0) || !Number.isFinite(rate)) return '—'
      var n = num(usd) / rate
      var symbol = unit === 'CNY' ? '¥' : '$'
      if (n > 0 && n < 0.0001) return '<' + symbol + '0.0001'
      return symbol + n.toLocaleString('en-US', { minimumFractionDigits: n === 0 || n >= 1 ? 2 : n < 0.01 ? 4 : 3,
        maximumFractionDigits: n === 0 || n >= 1 ? 2 : n < 0.01 ? 4 : 3 })
    }
    function useMoney() {
      var unit = useCurrency()
      var rates = React.useContext(MoneyContext)
      return function (usd) { return formatMoney(usd, unit, rates) }
    }

    function fmtPct(value, digits) {
      var n = Number(value)
      if (!Number.isFinite(n)) return '—'
      return n.toFixed(digits === undefined ? 1 : digits) + '%'
    }

    function share(part, whole) {
      return whole > 0 ? (part / whole) * 100 : 0
    }

    function shortDay(day) {
      return typeof day === 'string' && day.length >= 10 ? day.slice(5) : String(day)
    }

    /**
     * Assign a stable colour per credential.
     *
     * Ordered by the credential id, not by its rank in the current report: a key
     * must keep its colour when another key overtakes it, or the reader silently
     * misattributes a series after a busy day.
     */
    function credColors(rows) {
      var ids = []
      for (var i = 0; i < rows.length; i++) ids.push(rows[i].id)
      ids.sort()
      var map = {}
      for (var j = 0; j < ids.length; j++) map[ids[j]] = SERIES[j % SERIES.length]
      return map
    }

    // ── data source ──────────────────────────────────────────────────────────

    /**
     * Fetch the report.
     *
     * RPC first, HTTP second. The fallback matters: on a generation where the
     * connection channel is absent the page would otherwise render an empty
     * report that looks like "no spend" rather than "no transport".
     */
    function createSource(ctx) {
      var rpc = null
      var connection = ctx.get('connection')
      if (connection !== undefined && connection !== null && connection.rpc !== undefined) {
        rpc = connection.rpc
      }

      function http(payload) {
        return fetch('/api-ledger/report', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload || {}),
        }).then(function (response) {
          if (!response.ok) throw new Error('api-ledger: HTTP ' + response.status)
          return response.json()
        })
      }

      /**
       * Load the report. `payload` carries the reader's clock and, for the
       * conversation tab, the session to scope to.
       */
      function request(payload) {
        var body = payload || {}
        if (rpc === null) return http(body)
        return Promise.resolve(rpc.call('/api-ledger', 'report', body)).then(function (result) {
          if (result !== null && typeof result === 'object' && result.ok === true) return result.value
          rpc = null
          return http(body)
        }).catch(function () {
          rpc = null
          return http(body)
        })
      }
      var pending = new Map()
      return function load(payload) {
        var key = JSON.stringify([payload.sessionId, payload.range, payload.todayStart])
        if (pending.has(key)) return pending.get(key)
        var result = request(payload).finally(function () { pending.delete(key) })
        pending.set(key, result)
        return result
      }

    }

    /**
     * Carries the data source and dictionaries to a page without threading them
     * through Slot props: the source owns transport state (which carrier
     * worked), and a Slot re-render must not rebuild it.
     */
    var LedgerContext = React.createContext(null)

    /** The locale service, so a translator can subscribe to language changes. */
    var LocaleContext = React.createContext(null)

    /** Refresh visible readouts after completed calls, including across midnight. */
    function useReport(sessionId, range) {
      var source = React.useContext(LedgerContext)
      var pair = React.useState({ status: 'loading', data: null, error: null })
      var state = pair[0]
      var setState = pair[1]

      React.useEffect(function () {
        var alive = true
        function load() {
          if (source === null || document.visibilityState === 'hidden') return
          var d = new Date()
          var payload = {
            now: d.getTime(), range: range || 'all',
            // Local midnight, so "today" means the reader's day rather than UTC's.
            todayStart: new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime(),
            yesterdayStart: new Date(d.getFullYear(), d.getMonth(), d.getDate() - 1).getTime(),
          }
          if (typeof sessionId === 'string' && sessionId.length > 0) payload.sessionId = sessionId
          source.load(payload).then(function (data) {
            if (!alive) return
            if (data !== null && typeof data === 'object' && data.ok === true) {
              if (!data.usdRates || !data.today || !data.view || !Array.isArray(data.viewPools) || !Array.isArray(data.recent)) {
                setState({ status: 'error', data: null, error: 'host-version' })
              } else {
                setState({ status: 'ready', data: data, error: null })
              }
            } else {
              setState({ status: 'error', data: null, error: (data && data.error) || 'no-data' })
            }
          }).catch(function (error) {
            if (!alive) return
            setState({ status: 'error', data: null, error: error && error.message ? error.message : String(error) })
          })
        }
        setState({ status: 'loading', data: null, error: null })
        load()
        var timer = setInterval(load, 10000)
        // A hidden window skips polling; returning to it immediately refreshes.
        function onVisible() { if (document.visibilityState === 'visible') load() }
        document.addEventListener('visibilitychange', onVisible)
        return function () {
          alive = false
          clearInterval(timer)
          document.removeEventListener('visibilitychange', onVisible)
        }
      }, [source, sessionId, range])

      return state
    }

    // ── shared pieces ────────────────────────────────────────────────────────

    function Section(props) {
      return React.createElement('div', { style: S.sec },
        React.createElement('div', { style: S.secHead },
          React.createElement('h3', { style: S.secTitle }, props.title),
          props.note ? React.createElement('span', { style: S.secNote }, props.note) : null),
        props.children)
    }

    /** One billing pool, including any calls whose price is unknown. */
    function PoolCard(props) {
      var money = useMoney()
      var t = props.t
      var totals = props.entry.totals
      return React.createElement('div', { className: 'api-ledger-pool', style: { '--pool-color': POOL_COLOR[props.entry.pool] || POOL_COLOR.unknown } },
        React.createElement('div', { className: 'api-ledger-pool-label' }, props.label),
        React.createElement('div', { className: 'api-ledger-amount' }, totals.calls > 0 && totals.unpriced === totals.calls ? t('money.unpriced') : money(totals.usd)),
        React.createElement('div', { style: S.kpiSub }, t('pool.sub', { calls: fmtInt(totals.calls), tokens: fmtTok(tokenCount(totals)) })),
        props.comparison ? React.createElement(DayComparison, { data: props.comparison, pool: props.entry.pool, t: t }) : null,
        totals.unpriced > 0 ? React.createElement('div', { className: 'api-ledger-warning' }, t('money.partial', { count: totals.unpriced })) : null)
    }

    function DayComparison(props) {
      var money = useMoney()
      var find = function (totals) { return ((totals && totals.byPool) || []).find(function (row) { return row.pool === props.pool }) }
      var today = find(props.data.today)
      var yesterday = find(props.data.yesterday)
      var amount = function (row) { return row && row.unpriced > 0 ? props.t('money.unpriced') : money(row ? row.usd : 0) }
      return React.createElement('div', { className: 'api-ledger-comparison' }, props.t('report.compare', {
        today: amount(today), yesterday: props.data.yesterday == null ? props.t('report.noClock') : yesterday ? amount(yesterday) : props.t('report.noYesterday'),
      }))
    }

    function RecentCalls(props) {
      var money = useMoney()
      if (!props.rows.length) return null
      var rows = props.rows.map(function (row, i) {
          var date = new Date(row.time)
          var when = Number.isFinite(date.getTime()) ? date.toLocaleString() : '—'
          return React.createElement('li', { key: i },
            React.createElement('div', null, row.model || '—', React.createElement('small', null, when + ' · ' + (row.route || '—') + ' · ' + (props.labels[row.pool] || row.pool || '—'))),
            React.createElement('div', { style: { textAlign: 'right' } },
              React.createElement('strong', null, row.priced ? money(row.usd) : props.t('money.unpriced')),
              React.createElement('small', { title: props.t('col.input') + ': ' + fmtInt(row.inputTokens) + ' · ' + props.t('col.cacheRead') + ': ' + fmtInt(row.cacheReadTokens) + ' · ' + props.t('col.output') + ': ' + fmtInt(row.outputTokens) }, fmtTok(tokenCount(row)) + ' tok')))
        })
      return React.createElement(Section, { title: props.t('report.recent'), note: props.t('report.recentNote') },
        React.createElement('ol', { className: 'api-ledger-recent' }, rows.slice(0, 5)),
        rows.length > 5 ? React.createElement('details', { className: 'api-ledger-disclosure' },
          React.createElement('summary', null, props.t('report.moreCalls') + ' · ' + (rows.length - 5)),
          React.createElement('ol', { className: 'api-ledger-recent', start: 6 }, rows.slice(5))) : null)

    }

    function ModelDistribution(props) {
      var money = useMoney()
      if (!props.pools.length) return null
      return React.createElement(Section, { title: props.t('report.distribution'), note: props.t('report.known') },
        props.pools.map(function (entry) {
          return React.createElement('div', { key: entry.pool, className: 'api-ledger-detail', style: S.card },
            React.createElement('h4', { className: 'api-ledger-pool-heading' }, props.labels[entry.pool] || entry.pool),
            (entry.totals.byModel || []).map(function (row) {
              var pct = share(row.usd, entry.totals.usd)
              return React.createElement('div', { key: row.key, style: { marginTop: 8 } },
                React.createElement('div', { style: Object.assign({}, S.row, { justifyContent: 'space-between', flexWrap: 'wrap' }) },
                  React.createElement('span', { title: row.route || '' }, row.model || row.key),
                  React.createElement('span', { style: S.tdNum }, row.unpriced === row.calls ? props.t('money.unpriced') : money(row.usd), row.unpriced < row.calls && entry.totals.usd > 0 ? ' · ' + fmtPct(pct) : '')),
                entry.totals.byModel.length > 1 && entry.totals.usd > 0 ? React.createElement('div', { style: S.barTrack }, React.createElement('div', { style: Object.assign({}, S.barFill, { width: pct + '%', background: POOL_COLOR[entry.pool] || COST_COLOR }) })) : null)
            }))
        }))
    }

    /** Horizontal cost comparison: easier to rank visually than a table. */
    function KeyBars(props) {
      var fmtUsd = useMoney()
      var t = props.t
      var rows = props.rows || []
      if (rows.length === 0) return React.createElement('p', { style: S.empty }, t('state.empty'))
      var colors = credColors(rows)
      var max = 0
      for (var i = 0; i < rows.length; i++) if (num(rows[i].usd) > max) max = num(rows[i].usd)
      if (max <= 0) return React.createElement('p', { style: S.empty }, t('state.emptyCost'))

      return React.createElement('div', null, rows.map(function (row) {
        var color = colors[row.id]
        var tokens = tokenCount(row)
        return React.createElement('div', { key: row.id, style: { marginBottom: 10 } },
          React.createElement('div', { style: Object.assign({}, S.row, { justifyContent: 'space-between' }) },
            React.createElement('span', { style: S.row },
              React.createElement('span', { style: Object.assign({}, S.swatch, { background: color }) }),
              React.createElement('span', { style: { fontWeight: 550, fontSize: 12 } }, row.label || row.id)),
            React.createElement('span', {
              style: { fontVariantNumeric: 'tabular-nums', fontWeight: 600, fontSize: 12 },
            }, fmtUsd(row.usd))),
          rows.length < 2
            // A lone row is 100% of itself, so a full-width bar states nothing
            // and reads as a rendering bug. The bar exists to compare rows.
            ? null
            : React.createElement('div', { style: S.barTrack },
              React.createElement('div', {
                style: Object.assign({}, S.barFill, {
                  width: Math.max(1, share(row.usd, max)) + '%',
                  background: color,
                }),
              })),
          React.createElement('div', {
            style: Object.assign({}, S.faintText, { marginTop: rows.length < 2 ? 4 : 0 }),
          },
          t('session.row', { calls: fmtInt(row.calls), tokens: fmtTok(tokens) })
          + ' · ' + fmtPct(share(row.usd, props.totalUsd))))
      }))
    }

    function KeyTable(props) {
      var fmtUsd = useMoney()
      var t = props.t
      var rows = props.rows || []
      if (rows.length === 0) return React.createElement('p', { style: S.empty }, t('state.empty'))
      var labels = props.labels || {}
      var colors = credColors(rows)
      // Fixed layout obeys the widths declared on the FIRST row, so they belong
      // here: the credential column carries two lines, the numeric ones a few
      // characters. They sum to 100%.
      var head = [
        { t: t('col.credential'), n: false, w: '24%' },
        { t: t('col.pool'), n: false, w: '14%' },
        { t: t('col.calls'), n: true, w: '9%' },
        { t: t('col.input'), n: true, w: '9%' },
        { t: t('col.cacheRead'), n: true, w: '10%' },
        { t: t('col.output'), n: true, w: '9%' },
        { t: t('col.cost'), n: true, w: '12%' },
        { t: t('col.cacheHit'), n: true, w: '13%' },
      ]
      return React.createElement('div', { style: S.scroll },
        React.createElement('table', { className: 'api-ledger-table', role: 'table', style: S.table },
          React.createElement('thead', null,
            React.createElement('tr', null, head.map(function (col, i) {
              return React.createElement('th', {
                key: 'h' + i,
                style: Object.assign({}, S.th, col.n ? S.thNum : null, { width: col.w }),
              }, col.t)
            }))),
          React.createElement('tbody', null, rows.map(function (row, ri) {
            var denom = num(row.cacheReadTokens) + num(row.inputTokens)
            var hit = denom > 0 ? num(row.cacheReadTokens) / denom : null
            var routes = (row.routes || []).map(function (x) { return x.route }).join(' · ')
            return React.createElement('tr', { key: row.id, style: ri % 2 === 1 ? { background: C.card } : null },
              React.createElement('td', { 'data-label': head[0].t, style: S.td },
                React.createElement('div', { style: S.row },
                  React.createElement('span', { style: Object.assign({}, S.swatch, { background: colors[row.id] }) }),
                  React.createElement('div', { style: { minWidth: 0 } },
                    React.createElement('div', { style: S.name, title: row.label || row.id }, row.label || row.id),
                    React.createElement('div', { style: S.routeLine, title: routes },
                      routes.length > 0 ? routes : t('tag.noKeyRef'))))),
              React.createElement('td', { 'data-label': head[1].t, 'data-pool': true, style: S.td }, labels[row.pool] || row.pool),
              React.createElement('td', { 'data-label': head[2].t, style: Object.assign({}, S.td, S.tdNum) }, fmtInt(row.calls)),
              React.createElement('td', { 'data-label': head[3].t, style: Object.assign({}, S.td, S.tdNum) }, fmtTok(row.inputTokens)),
              React.createElement('td', { 'data-label': head[4].t, style: Object.assign({}, S.td, S.tdNum) }, fmtTok(row.cacheReadTokens)),
              React.createElement('td', { 'data-label': head[5].t, style: Object.assign({}, S.td, S.tdNum) }, fmtTok(row.outputTokens)),
              React.createElement('td', { 'data-label': head[6].t, style: Object.assign({}, S.td, S.tdNum, { fontWeight: 600 }) }, row.unpriced === row.calls && row.calls > 0 ? t('money.unpriced') : fmtUsd(row.usd)),
              React.createElement('td', { 'data-label': head[7].t, style: Object.assign({}, S.td, S.tdNum) },
                hit === null ? '—' : fmtPct(hit * 100)))
          }))))
    }

    // ── charts ───────────────────────────────────────────────────────────────

    /**
     * Daily tokens AND cost, on two labelled axes.
     *
     * Stacked token bars use the left scale; a cost line uses the right. Drawing
     * tokens alone under a heading that promises cost would be a chart that lies
     * about what it shows, and cost is the dimension actually being tracked.
     *
     * Draw ORDER matters: the transparent per-slot hit area is pushed LAST so it
     * sits ABOVE bars and line. SVG paints later elements on top, so pushing it
     * first would bury it, and hovering a bar (exactly where a reader points)
     * would show no tooltip at all.
     */
    function DailyChart(props) {
      var fmtUsd = useMoney()
      var t = props.t
      var days = (props.days || []).map(function (day) { return Object.assign({}, day, { inputTokens: num(day.inputTokens) + num(day.cacheWriteTokens) }) })
      if (days.length === 0) return React.createElement('p', { style: S.empty }, t('state.emptyDays'))

      if (days.length === 1) {
        var day = days[0]
        return React.createElement('div', null,
          React.createElement('p', { style: S.faintText }, day.day + ' · ' + t('report.singleDay')),
          React.createElement('div', { className: 'api-ledger-breakdown' },
            ['inputTokens', 'cacheReadTokens', 'outputTokens'].map(function (key, i) {
              return React.createElement('div', { key: key }, React.createElement('span', null, t(['band.input', 'band.cacheRead', 'band.output'][i]) + ' '), fmtTok(day[key]))
            })))
      }
      var W = 620
      var H = 240
      var L = 54
      var R = 52
      var T = 16
      var B = 30
      var plotW = W - L - R
      var plotH = H - T - B

      var maxTok = 0
      var maxCost = 0
      for (var i = 0; i < days.length; i++) {
        var total = num(days[i].inputTokens) + num(days[i].cacheReadTokens) + num(days[i].outputTokens)
        if (total > maxTok) maxTok = total
        if (num(days[i].usd) > maxCost) maxCost = num(days[i].usd)
      }
      if (maxTok <= 0) return React.createElement('p', { style: S.empty }, t('state.emptyTokens'))

      var bands = [
        { key: 'inputTokens', color: '#3b82f6', label: t('band.input') },
        { key: 'cacheReadTokens', color: '#f59e0b', label: t('band.cacheRead') },
        { key: 'outputTokens', color: '#10b981', label: t('band.output') },
      ]

      var slot = plotW / days.length
      var barW = Math.max(1.5, Math.min(22, slot * 0.62))
      var nodes = []

      var ticks = [0, 0.25, 0.5, 0.75, 1]
      for (var ti = 0; ti < ticks.length; ti++) {
        var gy = T + plotH - ticks[ti] * plotH
        nodes.push(React.createElement('line', {
          key: 'g' + ti, x1: L, y1: gy, x2: W - R, y2: gy,
          stroke: ti === 0 ? C.border : C.rule, strokeWidth: 1,
        }))
        nodes.push(React.createElement('text', {
          key: 'gl' + ti, x: L - 8, y: gy + 4, fontSize: 11, fill: C.faint, textAnchor: 'end',
        }, fmtTok(maxTok * ticks[ti])))
        nodes.push(React.createElement('text', {
          key: 'gr' + ti, x: W - R + 8, y: gy + 4, fontSize: 11, fill: COST_COLOR, textAnchor: 'start',
        }, fmtUsd(maxCost * ticks[ti])))
      }

      var hits = []
      var costPts = []
      for (var d = 0; d < days.length; d++) {
        var day = days[d]
        var bx = L + d * slot + (slot - barW) / 2
        var by = T + plotH
        for (var b = 0; b < bands.length; b++) {
          var v = num(day[bands[b].key])
          if (v <= 0) continue
          var h = (v / maxTok) * plotH
          by -= h
          nodes.push(React.createElement('rect', {
            key: day.day + bands[b].key, x: bx, y: by, width: barW, height: h, fill: bands[b].color,
          }))
        }
        var cx = L + d * slot + slot / 2
        var cy = T + plotH - (maxCost > 0 ? (num(day.usd) / maxCost) * plotH : 0)
        costPts.push(cx + ',' + cy)

        hits.push(React.createElement('rect', {
          key: 'hit' + day.day, x: L + d * slot, y: T, width: slot, height: plotH, fill: 'transparent',
        }, React.createElement('title', null, t('tip.day', {
          day: day.day,
          input: fmtInt(day.inputTokens),
          cache: fmtInt(day.cacheReadTokens),
          output: fmtInt(day.outputTokens),
          tokens: fmtInt(num(day.inputTokens) + num(day.cacheReadTokens) + num(day.outputTokens)),
          cost: fmtUsd(day.usd),
          calls: fmtInt(day.calls),
        }))))
      }

      if (costPts.length > 0) {
        nodes.push(React.createElement('polyline', {
          key: 'costline', points: costPts.join(' '), fill: 'none',
          stroke: COST_COLOR, strokeWidth: 1.8, strokeLinejoin: 'round', strokeLinecap: 'round',
        }))
        for (var ci = 0; ci < costPts.length; ci++) {
          var xy = costPts[ci].split(',')
          nodes.push(React.createElement('circle', {
            key: 'costdot' + ci, cx: Number(xy[0]), cy: Number(xy[1]), r: 2.4, fill: COST_COLOR,
          }))
        }
      }
      for (var hi = 0; hi < hits.length; hi++) nodes.push(hits[hi])

      var labelIdx = days.length <= 3
        ? [0, 1, 2].filter(function (ix) { return ix < days.length })
        : [0, Math.floor((days.length - 1) / 2), days.length - 1]
      for (var li = 0; li < labelIdx.length; li++) {
        var idx = labelIdx[li]
        nodes.push(React.createElement('text', {
          key: 'xl' + idx,
          x: L + idx * slot + slot / 2,
          y: H - 10,
          fontSize: 11,
          fill: C.faint,
          textAnchor: li === 0 ? 'start' : (li === labelIdx.length - 1 ? 'end' : 'middle'),
        }, shortDay(days[idx].day)))
      }

      return React.createElement('div', null,
        React.createElement('svg', {
          viewBox: '0 0 ' + W + ' ' + H,
          // Capped as well as sized: an SVG's intrinsic width can otherwise
          // contribute to its container's min-content width and widen the page.
          style: { width: '100%', maxWidth: '100%', height: 'auto', display: 'block' },
          role: 'img',
          'aria-label': t('aria.daily'),
        }, nodes),
        React.createElement('div', { style: S.legend },
          bands.map(function (band) {
            return React.createElement('span', { key: band.key, style: S.row },
              React.createElement('span', { style: Object.assign({}, S.swatch, { background: band.color }) }),
              React.createElement('span', { style: S.faintText }, band.label))
          }),
          React.createElement('span', { style: S.row },
            React.createElement('span', { style: Object.assign({}, S.lineSwatch, { background: COST_COLOR }) }),
            React.createElement('span', { style: Object.assign({}, S.faintText, { color: COST_COLOR }) }, t('band.cost'))),
          React.createElement('span', { style: S.faintText }, t('band.hoverHint'))))
    }

    /**
     * Capability radar, with SQRT normalization.
     *
     * These credentials span about 200x in magnitude. Linear normalization to
     * the maximum collapses every small series into the centre, so the chart
     * renders as one blob plus a few dots: present, but unreadable. A square
     * root compresses the range while preserving order, and each axis prints the
     * value it was normalized against so the scale stays decodable. The
     * transform is stated in the caption rather than hidden.
     */
    function Radar(props) {
      var fmtUsd = useMoney()
      var t = props.t
      var rows = props.rows || []
      if (rows.length === 0) return React.createElement('p', { style: S.empty }, t('state.emptyRadar'))
      // Normalization is per-axis against the largest row, so a single row
      // normalizes every axis to itself and always draws a full-radius
      // pentagon: a chart that cannot vary with its data. Omit it and say why.
      if (rows.length < 2) return React.createElement('p', { style: S.empty }, t('radar.single'))

      var axes = [
        { key: 'calls', label: t('axis.calls'), fmt: fmtInt },
        { key: 'tokens', label: t('axis.tokens'), fmt: fmtTok },
        { key: 'cost', label: t('axis.cost'), fmt: fmtUsd },
        { key: 'cache', label: t('axis.cache'), fmt: function (v) { return fmtPct(v * 100) } },
        { key: 'unit', label: t('axis.unit'), fmt: fmtUsd },
      ]
      function rawVal(row, key) {
        if (key === 'calls') return num(row.calls)
        if (key === 'tokens') {
          return num(row.inputTokens) + num(row.outputTokens) + num(row.cacheReadTokens) + num(row.cacheWriteTokens)
        }
        if (key === 'cost') return num(row.usd)
        if (key === 'cache') {
          var denom = num(row.cacheReadTokens) + num(row.inputTokens)
          return denom > 0 ? num(row.cacheReadTokens) / denom : 0
        }
        return num(row.calls) > 0 ? num(row.usd) / num(row.calls) : 0
      }

      var maxima = {}
      for (var a = 0; a < axes.length; a++) {
        if (axes[a].key === 'cache') { maxima[axes[a].key] = 1; continue }
        var max = 0
        for (var r = 0; r < rows.length; r++) {
          var v = rawVal(rows[r], axes[a].key)
          if (v > max) max = v
        }
        maxima[axes[a].key] = max > 0 ? max : 1
      }

      /** A ratio already in 0..1 (cache hit) is left alone; others get the sqrt. */
      function norm(row, axis) {
        var raw = rawVal(row, axis.key)
        if (axis.key === 'cache') return Math.max(0, Math.min(1, raw))
        var ratio = maxima[axis.key] > 0 ? raw / maxima[axis.key] : 0
        return Math.sqrt(Math.max(0, Math.min(1, ratio)))
      }

      var size = 320
      var cx = size / 2
      var cy = size / 2
      var radius = size / 2 - 58
      var colors = credColors(rows)
      function pt(index, ratio) {
        var angle = (Math.PI * 2 * index) / axes.length - Math.PI / 2
        var rad = radius * Math.max(0, Math.min(1, ratio))
        return [cx + Math.cos(angle) * rad, cy + Math.sin(angle) * rad]
      }

      var nodes = []
      var rings = [0.25, 0.5, 0.75, 1]
      for (var ri = 0; ri < rings.length; ri++) {
        var pts = []
        for (var pi = 0; pi < axes.length; pi++) pts.push(pt(pi, rings[ri]).join(','))
        nodes.push(React.createElement('polygon', {
          key: 'ring' + ri, points: pts.join(' '), fill: 'none',
          stroke: ri === rings.length - 1 ? C.border : C.rule, strokeWidth: 1,
        }))
        var rl = pt(0, rings[ri])
        nodes.push(React.createElement('text', {
          key: 'ringlab' + ri, x: rl[0] + 5, y: rl[1] + 3, fontSize: 9, fill: C.faint, textAnchor: 'start',
        }, String(Math.round(rings[ri] * 100)) + '%'))
      }
      for (var ai = 0; ai < axes.length; ai++) {
        var end = pt(ai, 1)
        nodes.push(React.createElement('line', {
          key: 'spoke' + ai, x1: cx, y1: cy, x2: end[0], y2: end[1], stroke: C.rule, strokeWidth: 1,
        }))
        var at = pt(ai, 1.15)
        // Anchor by side, so a left-hand label grows inward instead of off-canvas.
        var anchor = Math.abs(at[0] - cx) < 6 ? 'middle' : (at[0] > cx ? 'start' : 'end')
        nodes.push(React.createElement('text', {
          key: 'lab' + ai, x: at[0], y: at[1] - 4, fontSize: 11.5, fill: C.dim,
          textAnchor: anchor, dominantBaseline: 'middle',
        }, axes[ai].label))
        nodes.push(React.createElement('text', {
          key: 'max' + ai, x: at[0], y: at[1] + 9, fontSize: 9.5, fill: C.faint,
          textAnchor: anchor, dominantBaseline: 'middle',
        }, t('radar.max', { value: axes[ai].fmt(maxima[axes[ai].key]) })))
      }
      for (var rowIndex = 0; rowIndex < rows.length; rowIndex++) {
        var row = rows[rowIndex]
        var poly = []
        for (var aj = 0; aj < axes.length; aj++) {
          poly.push(pt(aj, norm(row, axes[aj])).join(','))
        }
        nodes.push(React.createElement('polygon', {
          key: 'area' + row.id, points: poly.join(' '),
          fill: colors[row.id], fillOpacity: 0.10,
          stroke: colors[row.id], strokeWidth: 2, strokeLinejoin: 'round',
        }, React.createElement('title', null,
          t('tip.radar', {
            name: row.label || row.id,
            calls: fmtInt(row.calls),
            cost: fmtUsd(row.usd),
            unit: fmtUsd(num(row.calls) > 0 ? num(row.usd) / num(row.calls) : 0),
          }))))
      }

      return React.createElement('div', null,
        React.createElement('svg', {
          viewBox: '0 0 ' + size + ' ' + size,
          style: { width: '100%', maxWidth: 400, height: 'auto', display: 'block', margin: '0 auto' },
          role: 'img',
          'aria-label': t('aria.radar'),
        }, nodes),
        React.createElement('div', { style: Object.assign({}, S.legend, { justifyContent: 'center' }) },
          rows.map(function (row) {
            return React.createElement('span', { key: row.id, style: S.row },
              React.createElement('span', { style: Object.assign({}, S.swatch, { background: colors[row.id] }) }),
              React.createElement('span', { style: S.faintText }, row.label || row.id))
          })),
        React.createElement('p', { style: Object.assign({}, S.faintText, { textAlign: 'center', margin: '6px 0 0' }) },
          t('radar.note')))
    }

    /**
     * Per-model detail.
     *
     * Route and model sit on separate lines (a combined route/model string is
     * hard to scan), and the columns the first version dropped are present:
     * cache reads, unit cost, and a share bar.
     */
    function ModelTable(props) {
      var fmtUsd = useMoney()
      var t = props.t
      var rows = props.rows || []
      if (rows.length === 0) return null
      var total = 0
      for (var i = 0; i < rows.length; i++) total += num(rows[i].usd)
      var head = [
        { t: t('col.routeModel'), n: false, w: '22%' },
        { t: t('col.calls'), n: true, w: '9%' },
        { t: t('col.input'), n: true, w: '9%' },
        { t: t('col.cacheRead'), n: true, w: '10%' },
        { t: t('col.output'), n: true, w: '9%' },
        { t: t('col.unitCost'), n: true, w: '13%' },
        { t: t('col.cost'), n: true, w: '13%' },
        { t: t('col.share'), n: true, w: '15%' },
      ]
      return React.createElement('div', { style: S.scroll },
        React.createElement('table', { className: 'api-ledger-table', role: 'table', style: S.table },
          React.createElement('thead', null,
            React.createElement('tr', null, head.map(function (col, hi) {
              return React.createElement('th', {
                key: 'mh' + hi,
                style: Object.assign({}, S.th, col.n ? S.thNum : null, { width: col.w }),
              }, col.t)
            }))),
          React.createElement('tbody', null, rows.map(function (row, ri) {
            var pct = share(row.usd, total)
            var route = typeof row.route === 'string' ? row.route : String(row.key || '')
            var model = typeof row.model === 'string' ? row.model : ''
            var pricedCalls = num(row.calls) - num(row.unpriced)
            var unit = pricedCalls > 0 ? num(row.usd) / pricedCalls : null
            return React.createElement('tr', { key: row.key, style: ri % 2 === 1 ? { background: C.card } : null },
              React.createElement('td', { 'data-label': head[0].t, style: S.td },
                React.createElement('div', { style: S.name, title: route }, route),
                React.createElement('div', { style: S.routeLine, title: model }, model)),
              React.createElement('td', { 'data-label': head[1].t, style: Object.assign({}, S.td, S.tdNum) }, fmtInt(row.calls)),
              React.createElement('td', { 'data-label': head[2].t, style: Object.assign({}, S.td, S.tdNum) }, fmtTok(row.inputTokens)),
              React.createElement('td', { 'data-label': head[3].t, style: Object.assign({}, S.td, S.tdNum) }, fmtTok(row.cacheReadTokens)),
              React.createElement('td', { 'data-label': head[4].t, style: Object.assign({}, S.td, S.tdNum) }, fmtTok(row.outputTokens)),
              React.createElement('td', { 'data-label': head[5].t, style: Object.assign({}, S.td, S.tdNum) }, unit === null ? '—' : fmtUsd(unit)),
              React.createElement('td', { 'data-label': head[6].t, style: Object.assign({}, S.td, S.tdNum, { fontWeight: 600 }) }, row.unpriced === row.calls && row.calls > 0 ? t('money.unpriced') : fmtUsd(row.usd)),
              React.createElement('td', { 'data-label': head[7].t, style: Object.assign({}, S.td, S.tdNum) },
                React.createElement('div', {
                  style: { display: 'flex', alignItems: 'center', gap: 6, justifyContent: 'flex-end', minWidth: 0 },
                },
                React.createElement('div', { style: S.miniTrack },
                  React.createElement('div', {
                    style: { width: Math.max(2, pct) + '%', height: '100%', background: COST_COLOR, borderRadius: 2 },
                  })),
                React.createElement('span', { style: { flexShrink: 0 } }, fmtPct(pct)))))
          }))))
    }

    // ── pages ────────────────────────────────────────────────────────────────

    function tokenCount(totals) {
      return num(totals.inputTokens) + num(totals.outputTokens) + num(totals.cacheReadTokens) + num(totals.cacheWriteTokens)
    }

    function CurrencySwitch(props) {
      var unit = useCurrency()
      return React.createElement('div', { className: 'api-ledger-segment', role: 'group', 'aria-label': props.t('currency.label') },
        ['CNY', 'USD'].map(function (value) {
          return React.createElement('button', { key: value, type: 'button', 'aria-pressed': unit === value,
            onClick: function () { setCurrency(value) } }, value)
        }))
    }

    function ReportPage(props) {
      var rangePair = React.useState(props.session ? 'all' : 'month')
      var sessionId = props.session && typeof props.sessionId === 'string' ? props.sessionId : null
      var state = useReport(sessionId, rangePair[0])
      return React.createElement(MoneyContext.Provider, { value: state.data && state.data.usdRates || { USD: 1 } },
        React.createElement(ReportFrame, { session: props.session },
          React.createElement(ReportBody, { state: state, session: props.session, sessionId: sessionId,
            range: rangePair[0], setRange: rangePair[1] })))
    }

    function ReportBody(props) {
      var source = React.useContext(LedgerContext)
      var t = useT(source.dicts)
      var unit = useCurrency()
      var state = props.state
      var data = state.data || {}
      var totals = data.view || {}
      var pools = data.viewPools || []
      var labels = data.poolLabels || {}
      var cacheBase = num(totals.inputTokens) + num(totals.cacheReadTokens)
      var periodLabel = props.session ? t('session.title') : t(props.range === 'all' ? 'report.all' : 'kpi.' + props.range)
      var metric = function (label, value) {
        return React.createElement('div', { key: typeof label === 'string' ? label : 'cache' }, React.createElement('dt', null, label), React.createElement('dd', null, value))
      }
      return React.createElement('div', { style: S.page },
        React.createElement('header', { className: 'api-ledger-header' },
          React.createElement('div', null,
            React.createElement('div', { className: 'api-ledger-eyebrow' }, t('page.title') + ' / ' + periodLabel),
            React.createElement('h2', { style: S.h1 }, t(props.session ? 'report.session' : 'report.title')),
            React.createElement('p', { style: S.sub }, t(props.session ? 'report.sessionSub' : 'report.subtitle'))),
          React.createElement(CurrencySwitch, { t: t })),
        React.createElement('div', { className: 'api-ledger-toolbar' },
          props.session ? React.createElement('span', { style: S.chip }, t('session.title')) :
            React.createElement('select', { 'aria-label': t('report.range'), value: props.range,
              onChange: function (event) { props.setRange(event.target.value) } },
              ['today', 'week', 'month', 'all'].map(function (range) {
                return React.createElement('option', { key: range, value: range }, t(range === 'all' ? 'report.all' : 'kpi.' + range))
              })),
          React.createElement('span', { style: S.faintText }, t('report.live'))),
        state.status === 'loading' ? React.createElement('p', { role: 'status', style: S.empty }, t('state.loading')) :
        state.status === 'error' ? React.createElement('p', { role: 'alert', className: 'api-ledger-warning' }, state.error === 'host-version' ? t('state.restart') : t('state.error', { message: state.error })) :
        props.session && !props.sessionId ? React.createElement('p', { style: S.empty }, t('state.noSession')) :
        React.createElement(React.Fragment, null,
          React.createElement(Section, { title: t('report.pools'), note: unit },
            pools.length === 0 ? React.createElement('p', { style: S.empty }, t('report.empty')) :
              React.createElement('div', { className: 'api-ledger-pools' }, pools.map(function (entry) {
                return React.createElement(PoolCard, { key: entry.pool, entry: entry, label: labels[entry.pool] || entry.pool, t: t, comparison: props.session ? null : data })
              }))),
          React.createElement('dl', { className: 'api-ledger-metrics' },
            metric(t('kpi.tokens'), fmtTok(tokenCount(totals))),
            metric(t('report.calls'), fmtInt(totals.calls)),
            metric(React.createElement('span', { title: t('report.cacheBasis') }, t('col.cacheHit')), cacheBase > 0 ? fmtPct(num(totals.cacheReadTokens) / cacheBase * 100) : '—'),
            metric(t('report.apis'), String((totals.byIdentity || []).length))),
          props.session ? React.createElement(RecentCalls, { rows: data.recent || [], labels: labels, t: t }) : null,
          React.createElement(ModelDistribution, { pools: pools, labels: labels, t: t }),
          pools.length > 0 ? React.createElement(Section, { title: t('report.trend'), note: t('report.dayLimit') },
            React.createElement('div', { className: 'api-ledger-charts' }, pools.map(function (entry) {
              return React.createElement('div', { key: entry.pool, className: 'api-ledger-chart', style: S.card },
                React.createElement('h4', { className: 'api-ledger-pool-heading' }, labels[entry.pool] || entry.pool),
                React.createElement(DailyChart, { days: (entry.totals.byDay || []).slice(-30), t: t }))
            }))) : null,
          pools.length > 0 ? React.createElement(Section, { title: t('report.details'), note: t('sec.model.note') },
            pools.map(function (entry) {
              var keys = entry.totals.byIdentity || []
              return React.createElement('div', { key: entry.pool, className: 'api-ledger-detail', style: S.card },
                React.createElement('h4', { className: 'api-ledger-pool-heading' }, labels[entry.pool] || entry.pool),
                keys.length > 1 ? React.createElement(KeyBars, { rows: keys, totalUsd: entry.totals.usd, t: t }) : null,
                React.createElement(KeyTable, { rows: keys, labels: labels, t: t }),
                React.createElement('details', { className: 'api-ledger-disclosure' },
                  React.createElement('summary', null, t('report.models')),
                  React.createElement(ModelTable, { rows: entry.totals.byModel || [], t: t })),
                keys.length > 1 ? React.createElement('details', { className: 'api-ledger-disclosure' },
                  React.createElement('summary', null, t('sec.radar')),
                  React.createElement(Radar, { rows: keys, t: t })) : null)
            })) : null,
          !props.session ? React.createElement(RecentCalls, { rows: data.recent || [], labels: labels, t: t }) : null,
          data.persistError ? React.createElement('p', { className: 'api-ledger-warning', role: 'alert' }, t('report.persist')) : null,
          num(data.missingUsage) > 0 ? React.createElement('p', { className: 'api-ledger-warning' }, t('report.missing', { count: data.missingUsage })) : null,
          React.createElement('footer', { className: 'api-ledger-footnote' },
            React.createElement('p', null, t('report.basis')),
            React.createElement('p', null, data.usdRates && data.usdRates.CNY > 0 ? t('report.fx', { rate: data.usdRates.CNY }) : t('report.fxMissing')))))
    }

    // Resident surfaces use the same report and currency as the full page.
    // They never treat an unbound session as global session spend.
    function SpendStatus(props) {
      var id = props.sessionId || (props.session && props.session.sessionId) || null
      var state = useReport(props.sidebar ? null : id, props.sidebar ? 'today' : 'all')
      if (!props.sidebar && !id) return null
      return React.createElement(MoneyContext.Provider, { value: state.data && state.data.usdRates || { USD: 1 } },
        React.createElement(SpendReadout, { state: state, sidebar: props.sidebar, wide: props.wide }))
    }

    // The settings shell exposes openSection only to its onboarding children.
    // Use its existing accessible controls, scoped to its own slot, rather
    // than changing private React state or navigating the conversation tab.
    function openLedgerSettings(label) {
      var seat = document.querySelector('[data-slot="sidebar.settings"]')
      if (!seat) return false
      var dialogSelector = '[role="dialog"][aria-modal="true"]'
      if (!seat.querySelector(dialogSelector)) {
        var trigger = seat.querySelector('button[aria-haspopup="dialog"]')
        if (!trigger) return false
        trigger.click()
      }
      var remaining = 30
      function select() {
        var dialog = seat.querySelector(dialogSelector)
        var buttons = dialog ? dialog.querySelectorAll('nav button') : []
        for (var i = 0; i < buttons.length; i++) {
          if ((buttons[i].textContent || '').trim() !== label) continue
          if (buttons[i].getAttribute('aria-current') !== 'true') buttons[i].click()
          buttons[i].focus()
          return
        }
        if (--remaining > 0) requestAnimationFrame(select)
      }
      requestAnimationFrame(select)
      return true
    }

    function SpendReadout(props) {
      var source = React.useContext(LedgerContext)
      var t = useT(source.dicts)
      var money = useMoney()
      var unit = useCurrency()
      var data = props.state.data
      var totals = data ? (props.sidebar ? data.today : data.session && data.session.totals) : null
      var pools = totals && totals.byPool || []
      var title = t(props.sidebar ? 'sidebar.title' : 'dock.title')
      var error = props.state.status === 'error'
      var status = error ? t('compact.error') : props.state.status === 'loading' ? t('state.loading') : t('compact.empty')
      var text = pools.map(function (pool) {
        return (data.poolLabels[pool.pool] || pool.pool) + ' ' + (pool.unpriced === pool.calls && pool.calls > 0 ? t('money.unpriced') : money(pool.usd))
      }).join(' · ')
      var warning = totals && num(totals.unpriced) > 0 ? t('money.partial', { count: totals.unpriced }) : ''
      var tooltip = title + ': ' + (text || status) + (warning ? ' · ' + warning : '') + '\n' + t('report.live') + '\n' + t('report.basis')
      if (props.sidebar) {
        var first = pools[0]
        return React.createElement('button', {
          type: 'button', className: 'api-ledger-status api-ledger-status--sidebar',
          'data-rail': props.wide === false ? 'true' : undefined,
          title: tooltip + '\n' + t('sidebar.open'), 'aria-label': t('sidebar.open') + ' · ' + tooltip,
          onClick: function () { openLedgerSettings(t('page.title')) },
        }, props.wide === false ? (unit === 'CNY' ? '¥' : '$') : React.createElement(React.Fragment, null,
          React.createElement('span', { className: 'api-ledger-status-label' }, title),
          !first || error ? React.createElement('span', null, status) :
            React.createElement('span', { className: 'api-ledger-status-pool' },
              React.createElement('span', null, POOL_ORDER.indexOf(first.pool) >= 0 ? t({ 'personal-deepseek': 'pool.official', corporate: 'pool.corporate', 'third-party': 'pool.thirdParty', unknown: 'pool.unknown' }[first.pool]) : first.pool),
              React.createElement('strong', null, first.unpriced === first.calls && first.calls > 0 ? t('money.unpriced') : money(first.usd))),
          pools.length > 1 ? React.createElement('span', null, t('sidebar.more', { count: pools.length - 1 })) : null,
          warning ? React.createElement('span', { className: 'api-ledger-warning', 'aria-label': warning }, '!') : null,
          React.createElement('span', { className: 'api-ledger-status-arrow', 'aria-hidden': true }, '›')))
      }
      return React.createElement('div', { className: 'api-ledger-status' + (props.sidebar ? ' api-ledger-status--sidebar' : ''),
        'data-rail': props.wide === false ? 'true' : undefined, title: tooltip, 'aria-label': tooltip },
        props.wide === false ? React.createElement('span', { 'aria-label': tooltip }, unit === 'CNY' ? '¥' : '$') :
          React.createElement(React.Fragment, null,
            React.createElement('span', { className: 'api-ledger-status-label' }, title),
            pools.length === 0 || error ? React.createElement('span', null, status) :
              pools.map(function (pool) {
                return React.createElement('span', { key: pool.pool, className: 'api-ledger-status-pool' },
                  React.createElement('span', { style: { color: POOL_COLOR[pool.pool] || C.dim } }, POOL_ORDER.indexOf(pool.pool) >= 0 ? t({ 'personal-deepseek': 'pool.official', corporate: 'pool.corporate', 'third-party': 'pool.thirdParty', unknown: 'pool.unknown' }[pool.pool]) : pool.pool),
                  React.createElement('strong', null, pool.unpriced === pool.calls && pool.calls > 0 ? t('money.unpriced') : money(pool.usd)))
              }),
            warning ? React.createElement('span', { className: 'api-ledger-warning' }, warning) : null,
            React.createElement('button', { type: 'button', title: t('currency.toggle'), 'aria-label': t('currency.toggle'),
              onClick: function () { setCurrency(unit === 'CNY' ? 'USD' : 'CNY') } }, unit)))
    }

    // ── plugin ───────────────────────────────────────────────────────────────

    return {
      name: 'dsh-api-ledger-client',
      // `slots` is a HARD dependency: without it this plugin contributes
      // nothing at all. Declaring it makes Cordis hold the plugin in `waiting`
      // and activate it once the service appears, instead of letting `apply`
      // run early against an undefined service and vanish.
      inject: ['slots'],
      apply: function (ctx) {
        var slots = ctx.get('slots')
        if (slots === undefined) {
          // Unreachable while the `inject` above is honoured. If it ever does
          // fire, say so loudly: the failure this replaces was a silent no-op
          // with a clean host log and no UI, which is indistinguishable from
          // "the plugin is not installed at all".
          console.error('dsh-api-ledger: slots service unavailable; the UI cannot register')
          return
        }

        var dicts = buildDicts()
        var source = createSource(ctx)

        // The locale service is OPTIONAL, and registering with it is GUARDED.
        //
        // Why guarded: this call sits ABOVE the slot registrations, so an
        // exception here aborts `apply` and the plugin mounts with no UI at
        // all — while the host stays healthy and logs nothing. The symptom is
        // "installed, but nothing appears", which this plugin already produced
        // once. Translations are a nicety; the UI is the product.
        var locale = ctx.get('locale')
        var hasLocale = locale !== undefined && locale !== null
        if (hasLocale && typeof locale.register === 'function') {
          try {
            // `ctx.effect` owns the disposer, so an unload removes the
            // namespace instead of leaving a duplicate occupant.
            ctx.effect(function () {
              return locale.register(dicts.NS, { zh: dicts.zh, en: dicts.en })
            })
          } catch (error) {
            // Continue untranslated (the dictionaries' own default language)
            // rather than losing both seats to a translation problem.
            console.error('dsh-api-ledger: locale registration failed; continuing untranslated', error)
          }
        }

        /**
         * A nav label that follows the active locale without re-registering.
         *
         * The slot catalogue states the contract: a thunk is re-read on every
         * projection, so a language switch needs no re-registration. Reading the
         * locale inside the thunk (rather than closing over one snapshot) is what
         * makes that true.
         */
        function labelFor(key) {
          return function () {
            var active = null
            if (hasLocale && typeof locale.getLocale === 'function') {
              try {
                active = locale.getLocale().active
              } catch (error) {
                // A locale read that fails must not blank the nav row.
                active = null
              }
            }
            return makeT(dicts, active)(key)
          }
        }

        var providerValue = { load: source, dicts: dicts }
        function withProviders(child) {
          return React.createElement(LedgerContext.Provider, { value: providerValue },
            React.createElement(LocaleContext.Provider, { value: hasLocale ? locale : null },
              React.createElement('style', null, LAYOUT_CSS), child))
        }

        function Page() {
          return withProviders(React.createElement(ReportPage, { session: false }))
        }

        function Compact(props) {
          var sessionId = props === null || props === undefined || typeof props.sessionId !== 'string'
            ? null
            : props.sessionId
          return withProviders(React.createElement(ReportPage, { session: true, sessionId: sessionId }))
        }

        function Dock(props) { return withProviders(React.createElement(SpendStatus, props)) }
        function Sidebar(props) { return withProviders(React.createElement(SpendStatus, Object.assign({}, props, { sidebar: true }))) }
        slots.inject('conversation.composer.dock', function () {
          return slots.register({ name: 'conversation.composer.dock', id: 'api-ledger', order: 20 }, Dock)
        })
        slots.inject('sidebar.footer.action', function () {
          return slots.register({ name: 'sidebar.footer.action', id: 'api-ledger', order: 20 }, Sidebar)
        })
        if (typeof window.addEventListener === 'function') ctx.effect(function () {
          function sync(event) {
            if (event.key === currencyKey) setCurrency(event.newValue === 'USD' ? 'USD' : 'CNY')
          }
          window.addEventListener('storage', sync)
          return function () { window.removeEventListener('storage', sync) }
        })

        // The full report, beside `dsh-bill` (30) rather than replacing it.
        slots.inject('settings.section', function () {
          return slots.register({
            name: 'settings.section',
            id: 'api-ledger',
            order: 36,
            label: labelFor('page.title'),
          }, Page)
        })

        // The compact readout, in the conversation it describes. Order 50 places
        // it AFTER the approval ledger (40): the rightmost tab.
        slots.inject('conversation.view', function () {
          return slots.register({
            name: 'conversation.view',
            id: 'api-ledger',
            order: 50,
            label: labelFor('page.title'),
          }, Compact)
        })
      },
    }

    return module.exports
  },
})

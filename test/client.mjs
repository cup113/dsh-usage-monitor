import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import React from "react";
import { create, act } from "react-test-renderer";

const source = readFileSync(new URL("../lib/client.js", import.meta.url), "utf8");
/** 使用实际无构建客户端与真实 React，仅替换宿主槽位、网络、时钟和本地存储。 */
function client(fetch, { storage = new Map(), search = "", clock = null } = {}) {
  let plugin, dictionary;
  const locales = {};
  const slots = {}, timers = [], listeners = {}, cleanups = [];
  const subscribe = (type, fn) => (listeners[type] ||= new Set()).add(fn);
  const unsubscribe = (type, fn) => listeners[type]?.delete(fn);
  const document = { querySelector: () => true, body: {}, visibilityState: "visible", addEventListener: subscribe, removeEventListener: unsubscribe };
  const window = {
    __ModuleLoader__: { load({ factory }) { plugin = factory((id) => id === "react" ? React : { createPortal: (child) => child }); } },
    location: { search }, addEventListener: subscribe, removeEventListener: unsubscribe,
    localStorage: { getItem: (key) => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value) },
  };
  const context = {
    window, document, fetch, console, location: window.location, AbortController, AbortSignal,
    requestAnimationFrame(fn) { fn(); return 0; },
    setTimeout(fn, ms) { const handle = { fn, ms }; timers.push(handle); return handle; },
    clearTimeout(handle) { const index = timers.indexOf(handle); if (index >= 0) timers.splice(index, 1); },
  };
  context.globalThis = context;
  // 只在测试进程内替换这个 context 的时钟：倒计时文案依赖「现在」，用真实时钟会让断言随运行时刻抖动。
  if (clock !== null) {
    const fixed = { Now: clock };
    context.Date = Object.assign(class extends Date {
      constructor(...args) { if (args.length === 0) super(fixed.Now); else super(...args); }
      static now() { return fixed.Now; }
    }, { parse: Date.parse, UTC: Date.UTC });
    context.__setNow = (value) => { fixed.Now = value; };
  }
  // 只为纯展示函数提供测试访问点，不修改生产导出或加载方式。
  vm.runInNewContext(source.replace("exports.apply = apply;", "exports.__test = { buildEntryView, selectPrimaryMetric, supplierStatus, connStateOf, seasonCountdown, seasonSplitText }; exports.apply = apply;"), context);
  plugin.apply({ locale: { register(ns, locales_) { Object.assign(locales, locales_); dictionary = locales_.zh; } }, effect(fn) { cleanups.push(fn()); }, slots: {
    inject(name, fn) { return fn(); }, register(descriptor, component) { slots[descriptor.name ?? descriptor.key] = component; },
  } });
  const t = (key, params = {}) => String(dictionary[key] ?? key).replace(/\{(\w+)\}/g, (_, k) => params[k] ?? `{${k}}`);
  return { Footer: slots["sidebar.footer.action"], Page: slots["settings.section"], t, locales, timers, storage, helpers: plugin.__test, setNow: context.__setNow };
}
const textOf = (node) => {
  const walk = (child) => Array.isArray(child) ? child.map(walk).join("") : typeof child === "string" || typeof child === "number" ? String(child) : child?.children ? walk(child.children) : "";
  return walk(node.children ?? node);
};
const line = (tree, name) => textOf(tree.root.findByProps({ className: name }));
const button = (tree, name) => tree.root.findAllByType("button").find((node) => textOf(node) === name || node.props["aria-label"] === name);
const tab = (tree, name) => tree.root.findAllByProps({ role: "tab" }).find((node) => textOf(node) === name);
const mount = async (host, props = {}, Component = host.Footer) => {
  let tree;
  await act(async () => { tree = create(React.createElement(Component, { wide: true, t: host.t, ...props })); });
  return tree;
};
const open = async (tree) => act(async () => { tree.root.findByProps({ "data-qm-entry": "" }).props.onClick(); });
/** 等首帧 /state 落地并触发依赖它的 effect（globalForm 就在 effect 里初始化）。 */
const flush = async () => { await act(async () => { await Promise.resolve(); }); };
const response = (data) => ({ ok: true, status: 200, json: async () => data });
const payload = (name, suppliers = []) => ({ ok: true, traffic: { channelAlive: true }, suppliers, active: { supplierId: suppliers[0]?.id, name, model: "model", at: Date.now() } });
const supplier = (entries, extra = {}) => ({ id: "opencode", name: "OpenCode", current: true, added: true, enabled: true, state: "ok", todayTokens: 0, entries, ...extra });

for (const wide of [true, false]) test(`${wide ? "expanded" : "rail"} sidebar opens a usage popover before independent details`, async () => {
  const host = client(async () => response(payload("A")));
  let tree;
  try {
    tree = await mount(host, { wide });
    await open(tree);
    assert.equal(tree.root.findAllByProps({ role: "dialog" }).length, 1);
    assert.equal(tree.root.findByProps({ role: "dialog" }).props["aria-label"], "用量");
    assert.equal(tree.root.findAllByProps({ role: "tab" }).length, 0);
    assert.equal(tree.root.findAllByProps({ className: "qm-pop" }).length, 1);
    await act(async () => button(tree, "详情").props.onClick());
    assert.equal(tree.root.findAllByProps({ className: "qm-pop" }).length, 0);
    assert.equal(tree.root.findByProps({ role: "dialog" }).props["aria-label"], "供应商限额明细");
    await act(async () => button(tree, "关闭").props.onClick());
    assert.equal(tree.root.findAllByProps({ role: "dialog" }).length, 0);
  } finally { await act(async () => tree?.unmount()); }
});

test("late state responses cannot overwrite a newer poll", async () => {
  const calls = [];
  const host = client((url) => new Promise((resolve) => calls.push({ url: String(url), resolve })));
  let tree;
  try {
    tree = await mount(host);
    assert.equal(calls.length, 1);
    assert.ok(host.timers.some((timer) => timer.ms === 30_000), "在途 GET 有 30s 上限");
    await act(async () => calls[0].resolve(response(payload("first"))));
    const poll = host.timers.find((timer) => timer.ms === 10_000);
    assert.ok(poll);
    await act(async () => poll.fn());
    assert.equal(calls.length, 2);
    await act(async () => calls[1].resolve(response(payload("new"))));
    await act(async () => calls[0].resolve(response(payload("old"))));
    assert.ok(line(tree, "qm-l2").includes("new"));
    assert.ok(!line(tree, "qm-l2").includes("old"));
  } finally { await act(async () => tree?.unmount()); }
});

test("expanded sidebar prioritizes the selected window and scopes today's total to current suppliers", async () => {
  const state = payload("OpenCode", [
    supplier([{ name: "5 小时", kind: "win", pct: 5, reset: "约 2 小时后重置" }, { name: "周用量", kind: "win", pct: 2, reset: "下周重置" }], { todayTokens: 64_429_367 }),
    supplier([{ name: "CNY", kind: "bal", remain: "¥41.99" }], { id: "deepseek", name: "DeepSeek", todayTokens: 1_318_275 }),
    supplier([], { id: "historic", name: "Historical", current: false, todayTokens: 100_000_000 }),
  ]);
  state.active.model = "deepseek-v4.1-flash-with-a-long-model-name";
  const host = client(async () => response(state));
  let tree;
  try {
    tree = await mount(host);
    assert.equal(line(tree, "qm-l1"), "用量监控");
    assert.equal(line(tree, "qm-l2"), "OpenCode · deepseek-v4.1-flash-with-a-long-model-name");
    assert.match(line(tree, "qm-l3"), /5 小时.*已用.*5%.*约 2 小时后重置/);
    assert.ok(!line(tree, "qm-l3").includes("下周"));
    assert.match(line(tree, "qm-today"), /65\.7M/);
    const entry = tree.root.findByProps({ "data-qm-entry": "" });
    assert.match(entry.props["aria-label"], /当前供应商.*今日.*Token.*本地日/);
    assert.ok(entry.props.title.includes(state.active.model));
    assert.equal(tree.root.findAllByProps({ className: "qm-dot ok" }).length, 1);
  } finally { await act(async () => tree?.unmount()); }
});

test("a page with no calls never borrows another page's supplier but retains scoped daily tokens", async () => {
  const state = { ...payload("", [supplier([{ kind: "win", name: "周期", pct: 3 }], { name: "DeepSeek", todayTokens: 1200 })]), active: null };
  const host = client(async () => response(state));
  let tree;
  try {
    tree = await mount(host);
    assert.equal(line(tree, "qm-l2"), "暂无调用");
    assert.ok(!line(tree, "qm-l3").includes("3%"));
    assert.ok(!line(tree, "qm-l2").includes("DeepSeek"));
    assert.match(line(tree, "qm-today"), /1K tokens/);
  } finally { await act(async () => tree?.unmount()); }
});

test("sidebar density is a versioned local preference; obsolete layout queries have no effect", async () => {
  const storage = new Map();
  for (const [search, initial, choose] of [["?qm-strip=B", "expanded", "收起"], ["?qm-strip=C", "compact", "展开"]]) {
    const host = client(async () => response(payload("A")), { storage, search });
    let tree;
    try {
      tree = await mount(host);
      assert.equal(tree.root.findAllByProps({ "data-qm-density": initial }).length, 1);
      assert.equal(tree.root.findAll((node) => node.props["data-qm-variant"] !== undefined).length, 0);
      await act(async () => button(tree, choose).props.onClick());
      assert.deepEqual(JSON.parse(storage.get("dsh-token-quota.ui.v1")), { sidebarDensity: initial === "expanded" ? "compact" : "expanded" });
    } finally { await act(async () => tree?.unmount()); }
  }
});

test("A1 pure display table separates percentages, balances, report periods, zero and unknown", () => {
  const { helpers, t } = client(async () => response(payload("A")));
  const cases = [
    [{ kind: "win", name: "5 小时", pct: 63 }, {}, "quota", "63%", "ok"],
    [{ kind: "win", name: "5 小时", pct: 0 }, {}, "quota", "0%", "ok"],
    [{ kind: "win", name: "未知", pct: null, used: null }, {}, "quota", "—", "neutral"],
    [{ kind: "win", name: "未知", pct: NaN, used: undefined }, {}, "quota", "—", "neutral"],
    [{ kind: "bal", name: "USD", remain: "$3", pct: null }, {}, "balance", "$3", "neutral"],
    [{ kind: "bal", name: "CNY", remain: 0 }, {}, "balance", "0", "neutral"],
    [{ kind: "cost", name: "最近完整 UTC 日", used: "$1.25", note: "2026-10-01 UTC" }, {}, "cost", "$1.25", "neutral"],
    [{ kind: "usage", name: "最近完整 UTC 日", used: "12K tokens" }, {}, "usage", "12K tokens", "neutral"],
    [{ kind: "win", name: "旧数据", pct: 98 }, { state: "err" }, "quota", "98%", "neutral"],
    [{ kind: "win", name: "已停用", pct: 98 }, { enabled: false }, "quota", "98%", "neutral"],
  ];
  for (const [entry, overrides, kind, value, tone] of cases) {
    const view = helpers.buildEntryView(entry, supplier([entry], overrides), t);
    assert.equal(view.kind, kind, entry.name);
    assert.equal(view.value, value, entry.name);
    assert.equal(view.tone, tone, entry.name);
    assert.equal(view.name, entry.name);
    if (["cost", "usage"].includes(kind)) assert.ok(!view.label.includes("余额") && !view.name.includes("今日"));
    if (overrides.state === "err") assert.equal(view.warning, null, "旧数据不得继续显示告警颜色或告警判断");
  }
  const currencies = supplier([{ kind: "bal", name: "USD", remain: "$3" }, { kind: "bal", name: "CNY", remain: "¥7" }]);
  const metric = helpers.selectPrimaryMetric(currencies, t);
  assert.equal(metric.value, "$3");
  assert.equal(metric.more, 1);
  assert.ok(!metric.text.includes("10"), "多币种不相加");
  assert.equal(helpers.supplierStatus(supplier([], { state: "err" }), t), "暂时无法获取");
  assert.equal(helpers.supplierStatus(supplier([{ kind: "bal", remain: "$3" }], { state: "err" }), t), "更新失败 · 上次数据");
  assert.equal(helpers.supplierStatus(supplier([], { enabled: false }), t), "未启用");
  assert.equal(helpers.supplierStatus(supplier([]), t), "尚未查询");
});

test("selected primary window owns its reset time and unknown reset does not borrow headline", () => {
  const { helpers, t } = client(async () => response(payload("A")));
  const resetAt = Date.now() + (2 * 60 + 13) * 60_000 + 30_000;
  const state = supplier([{ kind: "win", name: "5 小时", pct: 63, resetAt }, { kind: "win", name: "周用量", pct: 90, reset: "下周重置" }]);
  assert.equal(helpers.selectPrimaryMetric(state, t).name, "周用量");
  assert.equal(helpers.selectPrimaryMetric(state, t).reset, "下周重置");
  assert.match(helpers.buildEntryView(state.entries[0], state, t).reset, /2h1[23]m 后重置/);
  assert.equal(helpers.selectPrimaryMetric(supplier([{ kind: "win", name: "未提供时刻", pct: 95 }], { headline: { resetAt, reset: "错误窗口的重置" } }), t).reset, null);
  assert.equal(helpers.buildEntryView({ kind: "win", name: "占位", pct: 4, resetAt: 0, reset: "原始文案" }, state, t).reset, "原始文案");
  assert.equal(helpers.buildEntryView({ kind: "win", name: "错误单位", pct: 4, resetAt: 1791129600, reset: "—" }, state, t).reset, null);
  assert.equal(helpers.buildEntryView({ kind: "win", name: "已到期", pct: 4, resetAt: Date.now() - 1 }, state, t).reset, "即将重置");
  assert.equal(helpers.buildEntryView({ kind: "win", name: "长周期", pct: 4, resetAt: Date.now() + 43 * 60 * 60_000 + 30_000 }, state, t).reset, "1d19h 后重置");
});

test("connection observation ignores disabled failures and distinguishes unconfigured and degraded states", () => {
  const { helpers } = client(async () => response(payload("A")));
  assert.equal(helpers.connStateOf({ traffic: { channelAlive: true }, suppliers: [supplier([], { state: "err" })] }).key, "warn");
  assert.equal(helpers.connStateOf({ traffic: { channelAlive: false }, suppliers: [] }).key, "err");
  assert.equal(helpers.connStateOf({ traffic: { channelAlive: false }, suppliers: [supplier([])] }).key, "off");
  assert.equal(helpers.connStateOf({ traffic: { channelAlive: true }, suppliers: [supplier([], { state: "err", enabled: false, added: false })] }).key, "ok");
});

for (const [warnPct, critPct, tones] of [[undefined, undefined, ["ok", "ok", "ok", "ok"]], [50, 70, ["ok", "warn", "warn", "crit"]]]) {
  test(`overview and supplier preview share threshold classification ${warnPct ?? "default"}/${critPct ?? "default"}`, async () => {
    const state = payload("OpenCode", [supplier([49, 50, 60, 70].map((pct) => ({ kind: "win", name: `e${pct}`, pct, used: String(pct), limit: "100" })), { warnPct, critPct })]);
    const host = client(async () => response(state));
    let tree;
    const renderedTones = () => tree.root.findAll((node) => /^ci-big /.test(node.props.className || "")).map((node) => node.props.className);
    try {
      tree = await mount(host);
      await open(tree);
      await act(async () => button(tree, "详情").props.onClick());
      assert.deepEqual(renderedTones(), tones.map((tone) => `ci-big ${tone}`));
      const card = tree.root.findByProps({ "data-supplier": "opencode" });
      assert.ok(textOf(card).includes(tones.at(-1) === "crit" ? "临界" : "正常"));
      await act(async () => button(tree, "设置").props.onClick());
      await act(async () => button(tree, "配置").props.onClick());
      assert.deepEqual(renderedTones(), tones.map((tone) => `ci-big ${tone}`));
      assert.ok(textOf(tree.root.findByProps({ className: "qm-page-head" })).includes(tones.at(-1) === "crit" ? "临界" : "正常"));
    } finally { await act(async () => tree?.unmount()); }
  });
}

test("unknown percentage and healthy balance remain neutral; failed old values show their last success time", async () => {
  const state = payload("OpenCode", [supplier([{ kind: "bal", name: "USD", remain: "$3", pct: null }, { kind: "win", name: "未知", pct: undefined, used: null }], { state: "err", lastSuccessAt: Date.now() - 60_000, error: { message: "quota endpoint unavailable" } })]);
  const host = client(async () => response(state));
  let tree;
  try {
    tree = await mount(host);
    assert.match(line(tree, "qm-l1"), /更新失败 · 上次数据/);
    assert.match(line(tree, "qm-l3"), /\$3/);
    await open(tree);
    await act(async () => button(tree, "详情").props.onClick());
    const card = tree.root.findByProps({ "data-supplier": "opencode" });
    assert.ok(textOf(card).includes("quota endpoint unavailable"));
    assert.ok(textOf(card).includes("数据时间"));
    assert.ok(textOf(card).includes(new Date(state.suppliers[0].lastSuccessAt).toLocaleString()));
    assert.ok(!textOf(card).includes("0%"));
    assert.ok(!textOf(card).includes("无限额概念"));
    assert.deepEqual(card.findAll((node) => /^ci-big /.test(node.props.className || "")).map((node) => node.props.className), ["ci-big neutral", "ci-big neutral"]);
  } finally { await act(async () => tree?.unmount()); }
});

test("embedded settings preserves non-secret fields and retains rejected drafts", async () => {
  const posts = [];
  const data = payload("OpenCode", [supplier([], { orgId: "org-original", meta: { needs: [{ key: "apiKey", secret: true }, { key: "orgId", secret: false }] } })]);
  const host = client(async (url, opts) => {
    if (opts?.method !== "POST") return response(data);
    posts.push(JSON.parse(opts.body));
    return { ok: false, status: 400, json: async () => ({ ok: false, error: "validation rejected" }) };
  });
  let tree;
  try {
    tree = await mount(host, {}, host.Page);
    assert.equal(tree.root.findAllByProps({ role: "dialog" }).length, 0);
    await act(async () => tab(tree, "供应商").props.onClick());
    await act(async () => button(tree, "配置").props.onClick());
    assert.ok(tree.root.findAllByType("input").some((input) => input.props.value === "org-original"));
    await act(async () => button(tree, "保存").props.onClick());
    assert.equal(posts[0].suppliers.opencode.orgId, "org-original");
    assert.ok(!Object.hasOwn(posts[0].suppliers.opencode, "apiKey"));
    assert.equal(tree.root.findAllByProps({ className: "qm-page-head" }).length, 1);
    assert.equal(tree.root.findAllByProps({ className: "s-saved" }).length, 0);
    assert.equal(textOf(tree.root.findByProps({ role: "alert" })), "validation rejected");
    assert.ok(tree.root.findAllByType("input").some((input) => input.props.value === "org-original"));
  } finally { await act(async () => tree?.unmount()); }
});

// ---------- 峰谷计费时段（宿主下结论，客户端只展示） ----------

/** 直接问纯函数要倒计时文案：占位时刻必须得到 null（渲染路径之外的独立入口）。 */
const seasonCountdownOf = (host, flipAt, now) => host.helpers.seasonCountdown({ flipAt }, host.t, now);

/** 固定 flipAt 的时段载荷：避免用真实时钟导致倒计时文案随运行时刻抖动。 */
const seasonPayload = (season, suppliers = [supplier([])]) => ({
  ...payload("DeepSeek", suppliers),
  season: { peak: false, tier: "valley", kind: "weekday", valleyReason: null, beijing: { weekday: "周二", clock: "10:00", dayKey: "2026-10-13" }, warning: null, ...season },
});

test("expanded sidebar renders the billing tier with a live countdown; compact keeps it in the label only", async () => {
  const now = Date.UTC(2026, 9, 13, 2, 0, 0); // 北京时间 2026-10-13 10:00
  const flipAt = now + (3 * 3600 + 2 * 60) * 1000;
  const host = client(async () => response(seasonPayload({ flipAt, peak: true, tier: "peak" })), { clock: now });
  let tree, compactTree;
  try {
    tree = await mount(host);
    const row = tree.root.findByProps({ "data-qm-season": "peak" });
    assert.match(textOf(row), /峰价/);
    assert.match(textOf(row), /3h02m 后切换/, "倒计时由 flipAt 本地算出：" + textOf(row));
    assert.equal(row.findAll((node) => /qm-season-dot peak/.test(node.props.className || "")).length, 1);
    // 宿主时区为 +08:00（测试进程）时不加「按北京时间」后缀，避免噪音
    assert.ok(!textOf(row).includes("按北京时间"));
    const title = tree.root.findByProps({ "data-qm-entry": "" }).props.title;
    assert.ok(title.includes("北京时间"), "title 必须点名北京时间：" + title);
    await act(async () => tree.unmount());

    // 紧凑模式：行内不出现时段文案，但无障碍标签仍然带着它。
    // 必须换一个独立的 storage：density 是客户端模块级偏好，同一进程复用会让第二次挂载沿用第一次的展开态。
    const compactHost = client(async () => response(seasonPayload({ flipAt, peak: true, tier: "peak" })), {
      clock: now, storage: new Map([["dsh-token-quota.ui.v1", JSON.stringify({ sidebarDensity: "compact" })]]),
    });
    compactTree = await mount(compactHost);
    assert.equal(compactTree.root.findAllByProps({ "data-qm-density": "compact" }).length, 1, "先确认真的进了紧凑态");
    assert.equal(compactTree.root.findAllByProps({ "data-qm-season": "peak" }).length, 0, "紧凑模式不占字符");
    assert.ok(compactTree.root.findByProps({ "data-qm-entry": "" }).props.title.includes("峰价"));
    await act(async () => compactTree.unmount()); compactTree = null;

    // 切回完整：同一个宿主上按偏好恢复，证明这不是「一次性的查询参数」
    await act(async () => host.storage.set("dsh-token-quota.ui.v1", JSON.stringify({ sidebarDensity: "expanded" })));
    const expandedHost = client(async () => response(seasonPayload({ flipAt, peak: true, tier: "peak" })), {
      clock: now, storage: new Map([["dsh-token-quota.ui.v1", JSON.stringify({ sidebarDensity: "expanded" })]]),
    });
    tree = await mount(expandedHost);
    assert.equal(tree.root.findAllByProps({ "data-qm-season": "peak" }).length, 1);
  } finally { await act(async () => { compactTree?.unmount(); tree?.unmount(); }); }
});

test("season never invents a switch time: a placeholder flipAt shows the tier without a countdown", async () => {
  const host = client(async () => response(seasonPayload({ flipAt: 0 })));
  let tree;
  try {
    tree = await mount(host);
    const row = tree.root.findByProps({ "data-qm-season": "valley" });
    // 整行必须只有档位本身：出现任何倒计时文案（含「即将切换」）都是把占位时刻当成了真时刻
    assert.equal(textOf(row), "谷价", "占位 flipAt 只能渲染档位：" + textOf(row));
    assert.equal(seasonCountdownOf(host, 0, 1_800_000_000_000), null, "seasonCountdown 对占位时刻必须返回 null");
    assert.equal(seasonCountdownOf(host, 1_700_000_000, 1_800_000_000_000), null, "秒级值同样是占位，不得换算成倒计时");
    assert.equal(seasonCountdownOf(host, 1_800_000_600_000, 1_800_000_000_000), "10 分钟后切换", "合法时刻仍要给出倒计时");
    assert.equal(seasonCountdownOf(host, 1_800_000_600_000 + 2 * 3600_000, 1_800_000_000_000), "2h10m 后切换", "超过 1 小时用 h m");
    const title = tree.root.findByProps({ "data-qm-entry": "" }).props.title;
    assert.ok(!title.includes("切换"), "title 也不得出现切换文案：" + title);
  } finally { await act(async () => tree?.unmount()); }
});

test("peek popover explains the tier, the holiday reason and the coverage warning; the split only shows for DeepSeek", async () => {
  const now = Date.UTC(2026, 9, 13, 2, 0, 0);
  const flipAt = now + 65 * 60_000;
  const deepseek = { ...supplier([{ kind: "bal", remain: "¥8.22" }]), id: "deepseek", name: "DeepSeek",
    seasonSplit: { peakTokens: 0, valleyTokens: 3_400_000, unknownTokens: 0 } };
  const opencode = { ...supplier([]), todayTokens: 1 };
  const state = seasonPayload({ flipAt, valleyReason: "holiday", kind: "holiday", beijing: { weekday: "周六", clock: "11:20" }, warning: "节假日表缺少 2027 年的安排" }, [deepseek, opencode]);
  const host = client(async () => response(state), { clock: now });
  let tree;
  try {
    tree = await mount(host);
    await open(tree);
    const block = tree.root.findByProps({ "data-qm-season-block": "valley" });
    assert.match(textOf(block), /谷价/);
    assert.match(textOf(block), /法定节假日/, "谷价必须说明成因");
    assert.match(textOf(block), /1h05m 后切换/);
    assert.match(textOf(block), /节假日表缺少 2027 年/, "覆盖告警必须出现在面板上，而不是只写日志");
    const split = tree.root.findByProps({ "data-qm-season-split": "deepseek" });
    assert.match(textOf(split), /空闲 3\.4M（100%）/);
    assert.equal(tree.root.findAllByProps({ "data-qm-season-split": "opencode" }).length, 0, "其他供应商不串峰谷口径");
    await act(async () => button(tree, "详情").props.onClick());
    const detail = tree.root.findByProps({ className: "qm-cols" });
    assert.equal(detail.findAllByProps({ "data-qm-season-block": "valley" }).length, 1, "详情只给适用的供应商挂时段块");
  } finally { await act(async () => tree?.unmount()); }
});

test("today's split sums to the reported total and hides itself when there is nothing to split", async () => {
  const splitOf = (peakTokens, valleyTokens, unknownTokens) => ({ peakTokens, valleyTokens, unknownTokens });
  const deepseek = { ...supplier([]), id: "deepseek", name: "DeepSeek", seasonSplit: splitOf(1_200_000, 3_600_000, 0) };
  const host = client(async () => response(seasonPayload({ flipAt: Date.now() + 60_000 }, [deepseek])));
  let tree;
  try {
    tree = await mount(host);
    await open(tree);
    const split = textOf(tree.root.findByProps({ "data-qm-season-split": "deepseek" }));
    assert.match(split, /高峰 1\.2M（25%）/);
    assert.match(split, /空闲 3\.6M（75%）/);
    await act(async () => tree.unmount());

    // 无用量 / 只有未知段（早于峰谷定价的旧桶）时不编造结论
    const empty = client(async () => response(seasonPayload({}, [{ ...supplier([]), id: "deepseek", name: "DeepSeek", seasonSplit: splitOf(0, 0, 0) }])));
    tree = await mount(empty);
    await open(tree);
    assert.equal(tree.root.findAllByProps({ "data-qm-season-split": "deepseek" }).length, 0);
  } finally { await act(async () => tree?.unmount()); }
});

test("settings paste an explicit holiday override; invalid dates are rejected before saving", async () => {
  const posts = [];
  const host = client(async (url, opts) => {
    if (opts?.method !== "POST") return response(seasonPayload({}, [supplier([])]));
    posts.push(JSON.parse(opts.body));
    return response({ ok: true });
  });
  let tree;
  try {
    tree = await mount(host, {}, host.Page);
    // 全局设置（含节假日覆盖表）在「设置」页签下，不在默认的概览页
    await act(async () => tab(tree, "设置").props.onClick());
    await flush();
    const box = tree.root.findByType("textarea");
    assert.equal(box.props.value, "", "未配置时留空 = 用内置表");
    // 逗号/换行混排都要能接受
    await act(async () => box.props.onChange({ target: { value: "2027-01-02, 2027-01-01\n2027-02-06" } }));
    await act(async () => button(tree, "保存").props.onClick());
    assert.deepEqual(posts[0].holidays, ["2027-01-01", "2027-01-02", "2027-02-06"]);
    // 非法日期在前端就拦下，不发给宿主
    const before = posts.length;
    await act(async () => tree.root.findByType("textarea").props.onChange({ target: { value: "2027-02-30" } }));
    await act(async () => button(tree, "保存").props.onClick());
    assert.equal(posts.length, before, "非法日期不得提交");
    assert.match(textOf(tree.root.findByProps({ role: "alert" })), /2027-02-30/);
  } finally { await act(async () => tree?.unmount()); }
});

test("both locale dictionaries stay complete and agree on placeholders", () => {
  const host = client(async () => response(seasonPayload({})));
  const { zh, en } = host.locales;
  assert.deepEqual(Object.keys(zh).sort(), Object.keys(en).sort(), "新增文案必须中英双份");
  for (const key of Object.keys(zh)) {
    const placeholders = (text) => [...String(text).matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
    assert.deepEqual(placeholders(en[key]), placeholders(zh[key]), `占位符不一致：${key}`);
  }
});

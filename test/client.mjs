import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import React from "react";
import { create, act } from "react-test-renderer";

const source = readFileSync(new URL("../lib/client.js", import.meta.url), "utf8");
/** 使用实际无构建客户端与真实 React，仅替换宿主槽位、网络、时钟和本地存储。 */
function client(fetch, { storage = new Map(), search = "" } = {}) {
  let plugin, dictionary;
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
  // 只为纯展示函数提供测试访问点，不修改生产导出或加载方式。
  vm.runInNewContext(source.replace("exports.apply = apply;", "exports.__test = { buildEntryView, selectPrimaryMetric, supplierStatus, connStateOf }; exports.apply = apply;"), context);
  plugin.apply({ locale: { register(ns, locales) { dictionary = locales.zh; } }, effect(fn) { cleanups.push(fn()); }, slots: {
    inject(name, fn) { return fn(); }, register(descriptor, component) { slots[descriptor.name ?? descriptor.key] = component; },
  } });
  const t = (key, params = {}) => String(dictionary[key] ?? key).replace(/\{(\w+)\}/g, (_, k) => params[k] ?? `{${k}}`);
  return { Footer: slots["sidebar.footer.action"], Page: slots["settings.section"], t, timers, storage, helpers: plugin.__test };
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
const response = (data) => ({ ok: true, status: 200, json: async () => data });
const payload = (name, suppliers = []) => ({ ok: true, traffic: { channelAlive: true }, suppliers, active: { supplierId: suppliers[0]?.id, name, model: "model", at: Date.now() } });
const supplier = (entries, extra = {}) => ({ id: "opencode", name: "OpenCode", current: true, added: true, enabled: true, state: "ok", todayTokens: 0, entries, ...extra });

for (const wide of [true, false]) test(`${wide ? "expanded" : "rail"} sidebar directly opens and closes the monitor dialog`, async () => {
  const host = client(async () => response(payload("A")));
  let tree;
  try {
    tree = await mount(host, { wide });
    await open(tree);
    assert.equal(tree.root.findAllByProps({ role: "dialog" }).length, 1);
    assert.equal(tab(tree, "概览").props["aria-selected"], true);
    assert.equal(tree.root.findAllByProps({ className: "qm-pop" }).length, 0);
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
      assert.deepEqual(renderedTones(), tones.map((tone) => `ci-big ${tone}`));
      const card = tree.root.findByProps({ "data-supplier": "opencode" });
      assert.ok(textOf(card).includes(tones.at(-1) === "crit" ? "临界" : "正常"));
      await act(async () => card.findAllByType("button").find((node) => textOf(node) === "配置").props.onClick());
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

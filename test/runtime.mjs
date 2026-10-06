import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { apply, Config } from "../lib/index.js";
import { createCtx } from "./harness.mjs";
import { PROVIDERS } from "../lib/providers.js";
import * as season from "../lib/season.js";

test("plugin instances do not share traffic and dispose releases event handlers", async () => {
  const originalHome = process.env.DSH_HOME;
  const home = mkdtempSync(join(tmpdir(), "qm-runtime-"));
  process.env.DSH_HOME = home;
  const instances = [];
  function mount() {
    const { ctx, configRef, routes, events } = createCtx({ schema: Config, config: {} });
    const dispose = apply(ctx, configRef);
    instances.push(dispose);
    return { events, state() {
      let state;
      routes.get("/api/dsh-token-quota/state")({ method: "GET", headers: {}, url: "/api/dsh-token-quota/state" },
        { writeHead() {}, end(value) { state = JSON.parse(value); } });
      return state;
    } };
  }
  try {
    const first = mount();
    first.events.get("session/event")[0]({ id: "a" }, { type: "request/header", data: {
      config: { provider: "deepseek-official", model: "one" },
    } });
    const second = mount();
    assert.equal(first.state().active.model, "one");
    assert.equal(second.state().active, null);
    instances[0]();
    assert.equal(first.events.size, 0);
  } finally {
    for (const dispose of instances) dispose();
    if (originalHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = originalHome;
    rmSync(home, { force: true, recursive: true });
  }
});

test("state reports the last successful query time and never substitutes a failed attempt", async (t) => {
  const previousHome = process.env.DSH_HOME;
  const home = mkdtempSync(join(tmpdir(), "qm-state-time-"));
  process.env.DSH_HOME = home;
  let time = 1_800_000_000_000;
  let queryResult = { state: "err", error: { code: "network", message: "offline" }, entries: [] };
  const success = { state: "ok", entries: [{ type: "balance", remain: "10", unit: "CNY" }], headline: { kind: "amt", amt: "¥10" } };
  t.mock.method(Date, "now", () => time);
  t.mock.method(PROVIDERS.deepseek, "query", async () => queryResult);
  const harness = createCtx({ schema: Config, config: {
    suppliers: { deepseek: { enabled: true, apiKey: "saved" } },
  } });
  const dispose = apply(harness.ctx, harness.configRef);
  t.after(() => {
    dispose();
    if (previousHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previousHome;
    rmSync(home, { recursive: true, force: true });
  });
  const supplier = (payload) => payload.suppliers.find((s) => s.id === "deepseek");

  const failedFirst = supplier(await harness.call("/api/dsh-token-quota/refresh", {}));
  assert.equal(failedFirst.state, "err");
  assert.equal(Object.hasOwn(failedFirst, "lastSuccessAt"), false, "没有成功数据时省略成功时间");

  time += 5_000;
  queryResult = success;
  const succeeded = supplier(await harness.call("/api/dsh-token-quota/refresh", {}));
  assert.equal(succeeded.lastSuccessAt, time, "成功时间来自调度器的查询完成时刻");
  assert.equal(supplier(await harness.call("/api/dsh-token-quota/state")).lastSuccessAt, time);

  time += 5_000;
  queryResult = { state: "err", error: { code: "network", message: "offline again" }, entries: [] };
  const failedAgain = supplier(await harness.call("/api/dsh-token-quota/refresh", {}));
  assert.equal(failedAgain.state, "err");
  assert.deepEqual(failedAgain.entries, success.entries, "失败时继续提供上次有效数据");
  assert.equal(failedAgain.lastSuccessAt, succeeded.lastSuccessAt, "失败时间不得覆盖成功数据时间");
  assert.match(failedAgain.fetchedAt, /失败/);

  const changed = await harness.call("/api/dsh-token-quota/settings", {
    suppliers: { deepseek: { apiKey: "replacement", enabled: false } },
  });
  assert.equal(changed.ok, true);
  const reset = supplier(await harness.call("/api/dsh-token-quota/state"));
  assert.equal(Object.hasOwn(reset, "lastSuccessAt"), false, "配置变更后不得沿用旧凭据的数据时间");
  assert.equal(reset.error.code, "no-run");
});

test("season rides on /state as a host verdict; the holiday override round-trips through /settings", async (t) => {
  const previousHome = process.env.DSH_HOME;
  const home = mkdtempSync(join(tmpdir(), "qm-season-"));
  process.env.DSH_HOME = home;
  const harness = createCtx({ schema: Config, config: { suppliers: {} } });
  const warnings = [];
  harness.ctx.logger = { info() {}, warn: (...args) => warnings.push(args.join(" ")), error() {} };
  const dispose = apply(harness.ctx, harness.configRef);
  t.after(() => {
    dispose();
    if (previousHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previousHome;
    rmSync(home, { recursive: true, force: true });
  });
  const beijingDayKey = (at) => new Date(at.getTime() + 8 * 3600_000).toISOString().slice(0, 10);
  const weekdayNames = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];
  const now = new Date();

  // 1) 宿主下发结论，客户端不需要自己判定
  const first = await harness.call("/api/dsh-token-quota/state");
  assert.equal(typeof first.season.peak, "boolean");
  assert.equal(first.season.tier, first.season.peak ? "peak" : "valley");
  assert.ok(["weekday", "weekend", "holiday"].includes(first.season.kind));
  // 成因只可能出现在谷价里，且必须与 kind 一致
  assert.equal(first.season.valleyReason, first.season.peak ? null : (first.season.kind === "weekday" ? null : first.season.kind));
  assert.match(first.season.beijing.clock, /^\d{2}:\d{2}$/);
  assert.equal(first.season.beijing.weekday, weekdayNames[new Date(now.getTime() + 8 * 3600_000).getUTCDay()]);
  assert.equal(first.season.beijing.dayKey, beijingDayKey(now));
  if (first.season.flipAt !== null) assert.ok(first.season.flipAt > now.getTime(), "切换时刻必须在未来");
  assert.match(first.season.warning, /2027/, "缺次年必须在载荷里点名");
  assert.equal(first.season.warning,
    "节假日表缺少 2027 年的安排，工作日假期会被误判为峰价；可在用量监控设置里粘贴节假日覆盖表（已覆盖：2026）。");
  assert.ok(warnings.some((line) => /2027/.test(line)), "启动自检也要留一条日志：" + warnings.join(" | "));
  // 拆分只给 DeepSeek，其他供应商恒为 null（峰谷价只对 DeepSeek 成立）
  assert.deepEqual(first.suppliers.find((s) => s.id === "deepseek").seasonSplit,
    { peakTokens: 0, valleyTokens: 0, unknownTokens: 0 });
  assert.equal(first.suppliers.find((s) => s.id === "openrouter").seasonSplit, null);

  // 2) 合法覆盖表写入后立刻生效（热更新走 loader/volatile-update）。
  //    用「把今天标成放假日」做探针，并按今天在**内置表**里的客观身份推期望：
  //    工作日本来峰价 → 必须翻成谷价并报「节假日」；本来就放假（周末或内置节假日）→ 仍是谷价，
  //    但成因必须从原来的 weekend/内置 holiday 变成覆盖表命中的 holiday。
  const today = beijingDayKey(now);
  const builtinSaysHoliday = season.isBuiltinHoliday(today);
  const builtinDow = new Date(now.getTime() + 8 * 3600_000).getUTCDay();
  const builtinSaysWeekend = builtinDow === 0 || builtinDow === 6;
  const saves = await harness.call("/api/dsh-token-quota/settings", { holidays: [today] });
  assert.equal(saves.ok, true);
  const overridden = await harness.call("/api/dsh-token-quota/state");
  assert.equal(overridden.season.peak, false, `${today} 被标为放假日，不得再报峰价`);
  assert.equal(overridden.season.kind, "holiday", "覆盖表命中的那天成因必须是节假日");
  assert.equal(overridden.season.valleyReason, "holiday");
  assert.equal(overridden.season.warning, null, "用户自己贴了覆盖表就不再提示缺次年");
  assert.deepEqual(harness.settings.writes.at(-1).patch.holidays, [today]);
  if (!builtinSaysHoliday && !builtinSaysWeekend) {
    assert.equal(first.season.peak, true, "对照组：同一个工作日在覆盖前是峰价");
    assert.equal(first.season.kind, "weekday");
  }

  // 3) 坏日期在写入前被拒绝，且不能污染已保存的配置
  const rejected = await harness.call("/api/dsh-token-quota/settings", { holidays: ["2027-02-30"] });
  assert.equal(rejected.ok, false);
  assert.match(rejected.error, /非法日期/);
  const notArray = await harness.call("/api/dsh-token-quota/settings", { holidays: "2027-01-01" });
  assert.equal(notArray.ok, false);
  assert.deepEqual(harness.settings.userLayer.holidays, [today], "被拒绝的写入不得落盘");

  // 4) 配置被手工改坏时读取侧静默回落内置表，判定不消失
  harness.settings.userLayer.holidays = "not-an-array";
  const salvaged = await harness.call("/api/dsh-token-quota/state");
  assert.equal(salvaged.season.peak, first.season.peak, "坏配置回落到内置表，而不是让时段判定消失");
  assert.equal(salvaged.season.kind, first.season.kind);
});

test("today's split is attributed per hour and only DeepSeek gets one", async (t) => {
  const previousHome = process.env.DSH_HOME;
  const home = mkdtempSync(join(tmpdir(), "qm-split-"));
  process.env.DSH_HOME = home;
  const harness = createCtx({ schema: Config, config: { suppliers: { deepseek: { enabled: true, apiKey: "saved" } } } });
  const dispose = apply(harness.ctx, harness.configRef);
  t.after(() => {
    dispose();
    if (previousHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previousHome;
    rmSync(home, { recursive: true, force: true });
  });

  // 走真实事件通道喂一条 usage（与 usage-saves.mjs 同一形状），再确认载荷里的拆分与今日总量同源
  harness.emit("session/event", { id: "s1" }, { type: "assistant/chunk", data: {
    provider: "deepseek-official", turn: 1, step: 1,
    chunk: { type: "usage", usage: { inputTokens: 1_000, outputTokens: 0 } },
  } });
  const state = await harness.call("/api/dsh-token-quota/state");
  const deepseek = state.suppliers.find((s) => s.id === "deepseek");
  const split = deepseek.seasonSplit;
  assert.ok(deepseek.todayTokens > 0, "同一轮事件应已计入今日用量：" + deepseek.todayTokens);
  assert.equal(split.peakTokens + split.valleyTokens + split.unknownTokens, deepseek.todayTokens,
    "三段之和必须等于今日总量，不能因为拆分丢数");
  assert.equal(state.suppliers.find((s) => s.id === "openrouter").seasonSplit, null, "非 DeepSeek 供应商不挂拆分");
  // 今天的桶落在今天：断言两个各自独立计算的数字确实对得上，而不是各算各的
  assert.equal(split.unknownTokens, 0, "今天的桶晚于峰谷定价实施日，不该落进未知段");
});

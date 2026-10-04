import test from "node:test";
import assert from "node:assert/strict";
import { detectHarnessSuppliers } from "../lib/detect.js";
import { apply, Config } from "../lib/index.js";
import { createCtx } from "./harness.mjs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("desktop login route never borrows API key discovery from its API hostname", async () => {
  const result = await detectHarnessSuppliers({
    get: (name) => name === "settings" ? { describe: () => [{ ns: "account-route", value: { baseURL: "https://api.deepseek.com", apiKeyEnv: "QUOTA_TEST_UNSET_KEY" } }] } : name === "llm" ? {
      listProviders: () => [{ id: "deepseek-account" }],
      listConfigurableProviders: () => [{ provider: "deepseek-account", settingsNs: "account-route" }],
    } : undefined,
    settings: { describe: () => [{ ns: "account-route", value: { baseURL: "https://api.deepseek.com", apiKeyEnv: "QUOTA_TEST_UNSET_KEY" } }] },
  });
  const account = result.find(row => row.route === "deepseek-account");
  assert.equal(account.supplier, null);
  assert.equal(account.keyPresent, false);
  assert.match(account.reason, /同一账户的 API Key/);
});

test("rescan keeps settings access valid across asynchronous credential resolution", async (t) => {
  const previousHome = process.env.DSH_HOME;
  const home = mkdtempSync(join(tmpdir(), "qm-inactive-context-"));
  process.env.DSH_HOME = home;
  const previousTiming = globalThis.__DSH_SCAN_TIMING__;
  globalThis.__DSH_SCAN_TIMING__ = { manualTimeoutMs: 100, retryAfterFailureMs: 1_000 };
  const harness = createCtx({ schema: Config, foreign: [{
    ns: "llm-deepseek", value: { apiKeyEnv: "QUOTA_TEST_UNSET_KEY" }, user: { apiKeyEnv: "QUOTA_TEST_UNSET_KEY" },
  }] });
  let active = true;
  let settingsReady = true;
  const strictReads = [];
  const ctx = new Proxy({ ...harness.ctx, get(name) {
    if (name === "settings") return settingsReady ? harness.settings.service : undefined;
    if (name === "llm") return {
      listProviders: () => { active = true; return [{ id: "deepseek-official" }]; },
      listConfigurableProviders: () => [{ provider: "deepseek-official", settingsNs: "llm-deepseek" }],
    };
    if (name === "credentials") return { resolve: async () => { active = false; return null; } };
    return undefined;
  } }, { get(target, name) {
    if (name === "settings" && !active) {
      strictReads.push(name);
      throw new Error('cannot get required service "settings" in inactive context');
    }
    return target[name];
  } });
  let dispose;
  t.after(() => {
    dispose?.();
    if (previousTiming === undefined) delete globalThis.__DSH_SCAN_TIMING__; else globalThis.__DSH_SCAN_TIMING__ = previousTiming;
    if (previousHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = previousHome;
    rmSync(home, { recursive: true, force: true });
  });
  dispose = apply(ctx, harness.configRef);
  const result = await harness.call("/api/dsh-token-quota/rescan", {});
  assert.equal(result.ok, true, result.detect?.error || result.error);
  assert.equal(result.detect.error, null);
  assert.ok(result.detect.found.includes("deepseek"), "扫描必须保留真实配置的供应商，不能吞掉错误后返回空目录");
  settingsReady = false;
  const unavailable = await harness.call("/api/dsh-token-quota/rescan", {});
  assert.equal(unavailable.ok, false, "设置服务缺失时不能误报扫描成功");
  assert.match(unavailable.detect.error, /宿主设置服务暂不可用/);
  assert.ok(unavailable.detect.found.includes("deepseek"), "扫描失败必须保留最近成功目录");
  settingsReady = true;
  const recovered = await harness.call("/api/dsh-token-quota/rescan", {});
  assert.equal(recovered.ok, true);
  assert.equal(recovered.detect.error, null);
  assert.equal(strictReads.length, 0, "异步扫描不得依赖严格注入属性");
});

// Cordis 0.2 的可选服务只能由 get() 读取；未注入服务的属性访问会抛错。
for (const present of [false, true]) test(`desktop discovery tolerates absent optional services (llm present: ${present})`, async () => {
  const services = present ? { llm: { listProviders: () => [], listConfigurableProviders: () => [] } } : {};
  const ctx = new Proxy({
    get: (name) => name === "settings" ? ctx.settings : services[name],
    settings: { describe: () => [{ ns: "llm-deepseek", value: { apiKeyEnv: "QUOTA_TEST_UNSET_KEY" } }] },
  }, {
    get(target, name) {
      if (name === "credentials" || name === "llm") throw new Error(`cannot get property "${name}" without inject`);
      return target[name];
    },
  });
  const result = await detectHarnessSuppliers(ctx, { debug: true });
  assert.equal(result.meta.llmPresent, present);
  assert.equal(result.meta.credentialsPresent, false);
  assert.ok(result.some((record) => record.supplier === "deepseek"), "缺少凭据服务时仍须读取配置行");
});

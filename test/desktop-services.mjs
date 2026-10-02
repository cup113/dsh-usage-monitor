import test from "node:test";
import assert from "node:assert/strict";
import { detectHarnessSuppliers } from "../lib/detect.js";

test("desktop login route never borrows API key discovery from its API hostname", async () => {
  const result = await detectHarnessSuppliers({
    get: (name) => name === "llm" ? {
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

// Cordis 0.2 的可选服务只能由 get() 读取；未注入服务的属性访问会抛错。
for (const present of [false, true]) test(`desktop discovery tolerates absent optional services (llm present: ${present})`, async () => {
  const services = present ? { llm: { listProviders: () => [], listConfigurableProviders: () => [] } } : {};
  const ctx = new Proxy({
    get: (name) => services[name],
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

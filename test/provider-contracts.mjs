import test from "node:test";
import assert from "node:assert/strict";
import { PROVIDERS } from "../lib/providers.js";

test("OpenCode rejects a successful HTTP response without recognized data", async (t) => {
  t.mock.method(globalThis, "fetch", async () => ({ ok: true, text: async () => "{}" }));
  const result = await PROVIDERS.opencode.query({ apiKey: "fake" });
  assert.equal(result.state, "err");
  assert.equal(result.error.code, "no-data");
});

test("cancellation reaches the HTTP request and prevents subsequent pages", async (t) => {
  const controller = new AbortController();
  let calls = 0;
  t.mock.method(globalThis, "fetch", async (url, { signal }) => {
    calls++;
    return new Promise((resolve, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    });
  });
  const result = PROVIDERS["openai-org"].query({ apiKey: "fake" }, { signal: controller.signal });
  controller.abort();
  assert.equal((await result).state, "err");
  assert.equal(calls, 2); // 并发用量和费用各一个请求，没有后续分页。
});

// ---- C3：官方地址策略只有一个事实来源（探测可采纳地址 ≡ 查询可使用的基础地址）----
test("every official supplier accepts exactly its declared hosts/base paths and rejects the rest without network calls", async (t) => {
  const { OFFICIAL_ENDPOINTS, OFFICIAL_HOSTS } = await import("../lib/providers.js");
  const { isOfficialBaseUrl } = await import("../lib/providers.js");
  // 任何被拒绝的地址都不得触发网络调用
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => { calls++; return { ok: true, text: async () => "{}" }; });

  const otherHost = "evil.example.com";
  const rejected = (id) => {
    const spec = OFFICIAL_ENDPOINTS[id];
    const host = spec.hosts[0];
    return [
      `https://other.example.com`,                       // 非官方主机
      `http://${host}`,                                  // 非 HTTPS
      `https://${host}:8443`,                            // 非默认端口
      `https://user:pass@${host}`,                       // 携带用户信息
      `https://${host}/v1?x=1`,                          // 查询串
      `https://${host}/v1#frag`,                         // fragment
      `https://${host}/not-a-known-base`,                // 未声明的基础路径
      `https://sub.${host}`,                             // 子域不匹配（精确主机）
      `not a url`,
      "",
    ];
  };

  for (const [id, spec] of Object.entries(OFFICIAL_ENDPOINTS)) {
    assert.deepEqual(OFFICIAL_HOSTS[id], spec.hosts, `${id} 的主机策略必须与端点策略同源`);
    // 声明过的基础路径全部可采纳
    for (const path of spec.basePaths) {
      const url = `https://${spec.hosts[0]}${path}`;
      assert.equal(isOfficialBaseUrl(id, url), true, `${id} 应采纳官方地址 ${url}`);
    }
    // 未声明的形态一律拒绝
    for (const url of rejected(id)) {
      assert.equal(isOfficialBaseUrl(id, url), false, `${id} 必须拒绝 ${JSON.stringify(url)}`);
    }
    // 通过探测校验拒绝的地址，在查询入口也不得发出请求
    const before = calls;
    const result = await PROVIDERS[id].query({ apiKey: "fake", baseUrl: `https://${otherHost}` });
    assert.equal(result.state, "err", `${id} 使用非法地址必须直接失败`);
    // 单端点供应商报 endpoint；Admin 供应商（用量 + 费用两路合并）报 partial
    assert.ok(["endpoint", "partial"].includes(result.error.code),
      `${id} 非法地址应报端点错误（实际 ${result.error.code}），不得是网络错误`);
    assert.match(result.error.message, /Base URL/, `${id} 错误信息必须指出是地址问题`);
    assert.equal(calls, before, `${id} 非法地址不得触发任何网络调用`);
  }
  // 私有兼容来源没有官方白名单：它们的安全边界另行处理（只要求安全 HTTPS 形态）
  assert.equal(OFFICIAL_ENDPOINTS.opencode, undefined);
  assert.equal(OFFICIAL_ENDPOINTS.commandcode, undefined);
});

// ---- Z.ai / 智谱：用量桶改名（TOKENS_LIMIT → CREDIT_LIMIT）后的窗口分类契约 ----
// 实测（2026-10-06）：供应商把用量桶改名为 CREDIT_LIMIT，窗口身份只由 unit 决定
// （3 = 5 小时窗口，6 = 周窗口），并把业务失败塞进 HTTP 200 的响应体里。
const zaiEnvelope = (limits, envelope = {}) =>
  ({ code: 200, msg: "Operation successful", success: true, data: { limits, level: "lite" }, ...envelope });
const mockZai = (t, body) =>
  t.mock.method(globalThis, "fetch", async () => ({ ok: true, status: 200, text: async () => JSON.stringify(body) }));

test("Z.ai classifies usage buckets by unit, not by array position or spelling", async (t) => {
  mockZai(t, zaiEnvelope([
    { type: "CREDIT_LIMIT", unit: 6, number: 1, percentage: 42, nextResetTime: 1791781957965 },
    { type: "TOKENS_LIMIT", unit: 3, number: 5, percentage: 7 }, // 滚动发布：旧拼写仍在
  ]));
  const result = await PROVIDERS["zai-cn"].query({ apiKey: "fake" });
  assert.equal(result.state, "ok");
  assert.deepEqual(result.entries.map((e) => [e.name, e.pct]),
    [["Token 用量（5 小时）", 7], ["Token 用量（周）", 42]],
    "周窗口排在数组前面也不得挂到 5 小时标签下");
  assert.equal(result.entries[1].resetAt, 1791781957965, "周窗口的 epoch-毫秒重置时刻原样下发");
  assert.equal(result.entries[0].resetAt, null, "没有 nextResetTime 就不伪造时刻");
});

test("Z.ai drops an unknown-unit window instead of mislabelling it", async (t) => {
  mockZai(t, zaiEnvelope([
    { type: "CREDIT_LIMIT", unit: 4, number: 1, percentage: 99 }, // 未来新增窗口：不得冒充已知窗口
    { type: "CREDIT_LIMIT", unit: 3, number: 5, percentage: 7 },
  ]));
  const result = await PROVIDERS["zai-cn"].query({ apiKey: "fake" });
  assert.equal(result.state, "ok");
  assert.deepEqual(result.entries.map((e) => [e.name, e.pct]), [["Token 用量（5 小时）", 7]]);
});

test("Z.ai rejects a window named twice, in either spelling", async (t) => {
  mockZai(t, zaiEnvelope([
    { type: "TOKENS_LIMIT", unit: 6, number: 1, percentage: 42 },
    { type: "CREDIT_LIMIT", unit: 6, number: 1, percentage: 15 }, // 同一窗口的两种拼写 = 重复，不挑一个显示
  ]));
  const result = await PROVIDERS["zai-cn"].query({ apiKey: "fake" });
  assert.equal(result.state, "err");
  assert.equal(result.error.code, "schema");
});

test("Z.ai rejects a payload whose usage buckets carry no known unit", async (t) => {
  // 有用量桶却一个 unit 都认不出：供应商再次改版，不能退化成「没有窗口」
  mockZai(t, zaiEnvelope([{ type: "CREDIT_LIMIT", unit: 9, percentage: 1 }]));
  const result = await PROVIDERS["zai-cn"].query({ apiKey: "fake" });
  assert.equal(result.state, "err");
  assert.equal(result.error.code, "schema");
  assert.match(result.error.message, /unit/, "错误信息要指出是按 unit 分类失败");
});

test("Z.ai maps a business-level 401 inside an HTTP 200 body to auth", async (t) => {
  // 密钥失效：HTTP 200 + success:false + code 401 —— 只看状态码会误报成解析失败
  mockZai(t, { code: 401, msg: "token expired or incorrect", success: false });
  const result = await PROVIDERS["zai-cn"].query({ apiKey: "fake" });
  assert.equal(result.state, "err");
  assert.equal(result.error.code, "auth", "业务层 401 必须归到 auth，而不是 schema");
  assert.match(result.error.message, /token expired/);
});

test("Z.ai reports other business failures as schema, never as auth", async (t) => {
  mockZai(t, { code: 500, msg: "internal error", success: false });
  const result = await PROVIDERS["zai-cn"].query({ apiKey: "fake" });
  assert.equal(result.state, "err");
  assert.equal(result.error.code, "schema");
  assert.match(result.error.message, /internal error/);
});

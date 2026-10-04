import { test, expect } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";

const BASE = "http://127.0.0.1:4179";
const baseConfig = { suppliers: { opencode: { enabled: true, orgId: "org-original" } } };
const visualDirectory = resolve(".scratch/sidebar-ui-visual");
const displayFixture = () => ({
  ok: true, now: Date.now(), traffic: { channelAlive: true },
  active: { supplierId: "opencode", name: "OpenCode", model: "deepseek-v4.1-flash-with-a-very-long-model-name", at: Date.now() },
  suppliers: [
    { id: "opencode", name: "OpenCode", enabled: true, added: true, current: true, state: "ok", todayTokens: 1_240_000,
      warnPct: 80, critPct: 95, lastSuccessAt: Date.now(), entries: [
        { kind: "win", name: "5 小时", pct: 63, limit: "100%", used: "63%", resetAt: Date.now() + 7_980_000 },
        { kind: "win", name: "周用量", pct: 40, limit: "100%", used: "40%" },
      ] },
    { id: "deepseek", name: "DeepSeek", enabled: true, added: true, current: true, state: "err", todayTokens: 12_000,
      lastSuccessAt: Date.now() - 3_600_000, error: { message: "查询超时" }, entries: [
        { kind: "bal", name: "USD", remain: "$3.20", pct: null },
        { kind: "bal", name: "CNY", remain: "¥41.99", pct: null },
      ] },
  ],
});
const useDisplayFixture = (page) => page.route(/\/api\/dsh-token-quota\/state(?:\?.*)?$/, (route) => route.fulfill({ json: displayFixture() }));
test("restored details show supplier columns and a bounded history table before settings", async ({ page }) => {
  const fixture = displayFixture();
  fixture.suppliers.push({ id: "commandcode", name: "Command Code", added: true, enabled: true, state: "ok",
    entries: [{ kind: "win", name: "5h 窗口", pct: 0, limit: "100%", used: "0%" }] });
  fixture.suppliers.push({ id: "hidden", name: "Unconfigured", added: false, entries: [] });
  fixture.history = Array.from({ length: 55 }, (_, i) => ({ t: `2026-10-04 12:00:${i}`, supplier: "OpenCode", ok: i !== 0, summary: "5h · 63%", error: i === 0 ? "fixture timeout" : null }));
  await page.route(/\/api\/dsh-token-quota\/state(?:\?.*)?$/, route => route.fulfill({ json: fixture }));
  await page.goto("/");
  await page.locator("[data-qm-entry]").click();
  const detail = page.getByRole("dialog", { name: "供应商限额明细", exact: true });
  await expect(detail).toBeVisible();
  await expect(detail.getByRole("tab")).toHaveCount(0);
  await expect(detail.locator(".qm-col")).toHaveCount(3);
  await expect(detail).not.toContainText("Unconfigured");
  const columns = await detail.locator(".qm-col").evaluateAll(nodes => nodes.map(node => node.getBoundingClientRect().top));
  expect(new Set(columns).size).toBe(1);
  await detail.getByRole("button", { name: "关闭", exact: true }).focus();
  await page.keyboard.press("Tab");
  await expect(detail.locator(".qm-history summary")).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(detail.getByRole("columnheader")).toHaveText(["时间", "供应商", "结果", "主指标", "备注"]);
  await expect(detail.locator("tbody tr")).toHaveCount(50);
  await expect(detail.locator("tbody tr").first()).toContainText("fixture timeout");
  await mkdir(visualDirectory, { recursive: true });
  await page.screenshot({ path: resolve(visualDirectory, "restored-details.png"), fullPage: true });
  await detail.getByRole("button", { name: "设置", exact: true }).click();
  await expect(detail).toHaveCount(0);
  const settings = page.getByRole("dialog", { name: "用量监控", exact: true });
  await expect(settings.getByRole("tab")).toHaveCount(3);
  await page.keyboard.press("Escape");
  await expect(settings).toHaveCount(0);
  await expect(page.locator("[data-qm-entry]")).toBeFocused();
});
test.beforeEach(async ({ request }) => {
  await request.post(`${BASE}/__control`, { data: { stateDelay: 0, settingsDelay: 0, settingsFail: false, postCount: 0, config: baseConfig } });
});

for (const [width, density] of [[240, "expanded"], [180, "compact"], [64, "rail"]]) {
  test(`A2 ${width}px sidebar directly opens details and returns focus`, async ({ page }) => {
    await useDisplayFixture(page);
    await page.goto(density === "rail" ? "/?rail&width=64" : `/?width=${width}`);
    const opener = page.locator("[data-qm-entry]");
    if (density !== "rail") await expect(page.locator("[data-qm-density]")).toHaveAttribute("data-qm-density", density);
    if (density !== "rail") {
      await expect(opener.locator(".qm-primary")).toContainText("63%");
      const entryBox = await opener.boundingBox(), metricBox = await opener.locator(".qm-primary").boundingBox();
      expect(metricBox.width).toBeGreaterThan(40);
      expect(metricBox.x + metricBox.width).toBeLessThanOrEqual(entryBox.x + entryBox.width);
    }
    await opener.click();
    const dialog = page.getByRole("dialog", { name: "供应商限额明细", exact: true });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole("tab")).toHaveCount(0);
    if (width === 240) {
      await expect(dialog.locator('[data-supplier="deepseek"]')).toContainText("更新失败 · 上次数据");
      await expect(dialog.locator('[data-metric-kind="balance"]')).toHaveCount(2);
      await mkdir(visualDirectory, { recursive: true });
      await page.screenshot({ path: resolve(visualDirectory, "overview-normal-and-stale.png"), fullPage: true });
    }
    await expect(page.locator(".qm-pop")).toHaveCount(0);
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    await expect(opener).toBeFocused();
  });
}

test("A2 sidebar preference persists and automatic narrow layout never overwrites it", async ({ page }) => {
  await page.goto("/");
  const strip = page.locator("[data-qm-density]");
  await expect(strip).toHaveAttribute("data-qm-density", "expanded");
  await page.getByRole("button", { name: "收起", exact: true }).click();
  await expect(strip).toHaveAttribute("data-qm-density", "compact");
  await page.reload();
  await expect(strip).toHaveAttribute("data-qm-density", "compact");
  await page.getByRole("button", { name: "展开", exact: true }).click();
  await expect(strip).toHaveAttribute("data-qm-density", "expanded");
  await page.evaluate(() => window.__qmHost.setWidth(180));
  await expect(strip).toHaveAttribute("data-qm-density", "compact");
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem("dsh-token-quota.ui.v1")))).toEqual({ sidebarDensity: "expanded" });
  await page.evaluate(() => window.__qmHost.setWidth(240));
  await expect(strip).toHaveAttribute("data-qm-density", "expanded");
  await page.locator("[data-qm-entry]").click();
  await page.getByRole("dialog", { name: "供应商限额明细", exact: true }).getByRole("button", { name: "设置", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "用量监控", exact: true });
  await dialog.getByRole("tab", { name: "设置", exact: true }).click();
  await dialog.getByLabel("侧栏显示", { exact: true }).selectOption("compact");
  await expect(strip).toHaveAttribute("data-qm-density", "compact");
});

test("A3 dialog traps focus, preserves organization and retains a rejected draft", async ({ page }) => {
  await page.goto("/");
  const opener = page.locator("[data-qm-entry]");
  await opener.click();
  await page.getByRole("dialog", { name: "供应商限额明细", exact: true }).getByRole("button", { name: "设置", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "用量监控", exact: true });
  await expect(dialog).toHaveAttribute("aria-modal", "true");
  await expect.poll(() => dialog.evaluate((node) => node.contains(document.activeElement))).toBe(true);
  await dialog.locator("button:visible").last().focus();
  await page.keyboard.press("Tab");
  await expect.poll(() => dialog.evaluate((node) => node.contains(document.activeElement))).toBe(true);
  await dialog.getByRole("tab", { name: "供应商", exact: true }).click();
  await dialog.locator('.qm-page-row[data-supplier="opencode"]').getByRole("button", { name: "配置", exact: true }).click();
  const orgInput = dialog.getByLabel("org id（可选）", { exact: true });
  await expect(orgInput).toHaveValue("org-original");
  const advanced = dialog.locator("details.qm-advanced");
  await expect(advanced).not.toHaveAttribute("open", "");
  await advanced.locator("summary").click();
  const warning = advanced.locator('input[type="number"][max="99"]');
  await warning.fill("150");
  await advanced.locator("summary").click();
  await dialog.getByRole("button", { name: "保存", exact: true }).click();
  await expect(dialog.getByRole("alert")).toBeVisible();
  await expect(advanced).toHaveAttribute("open", "");
  await expect(warning).toHaveValue("150");
  await expect(orgInput).toHaveValue("org-original");
  await warning.fill("80");
  await dialog.getByRole("button", { name: "保存", exact: true }).click();
  await expect(dialog.locator(".qm-page-list")).toBeVisible();
  await dialog.locator('.qm-page-row[data-supplier="opencode"]').getByRole("button", { name: "配置", exact: true }).click();
  await expect(dialog.getByLabel("org id（可选）", { exact: true })).toHaveValue("org-original");
});

for (const light of [false, true]) {
  test(`A3 ${light ? "light" : "dark"} narrow panel remains inside viewport`, async ({ page }) => {
    await useDisplayFixture(page);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`/?rail${light ? "&light" : ""}`);
    const opener = page.locator("[data-qm-entry]");
    await opener.click();
    const dialog = page.getByRole("dialog", { name: "供应商限额明细", exact: true });
    await expect(dialog).toBeVisible();
    await expect(dialog.locator('[data-metric-kind="balance"]')).toHaveCount(2);
    const box = await dialog.boundingBox();
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(390);
    expect(await dialog.evaluate((node) => node.scrollWidth <= node.clientWidth + 1)).toBe(true);
    await mkdir(visualDirectory, { recursive: true });
    await page.screenshot({ path: resolve(visualDirectory, `narrow-${light ? "light" : "dark"}.png`), fullPage: true });
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    await expect(opener).toBeFocused();
  });
}

test("A3 embedded settings has no modal restrictions and sidebar reuses it", async ({ page }) => {
  await page.goto("/?settings");
  const panel = page.locator(".qm-settings-page");
  await expect(panel).toBeVisible();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.locator(".qm-overlay")).toHaveCount(0);
  await panel.getByRole("tab", { name: "设置", exact: true }).click();
  await page.locator("#background").focus();
  await page.keyboard.press("Escape");
  await expect(panel).toBeVisible();
  await expect(page.locator("#background")).toBeFocused();
  await page.locator("[data-qm-entry]").click();
  await page.getByRole("dialog", { name: "供应商限额明细", exact: true }).getByRole("button", { name: "设置", exact: true }).click();
  await expect(panel.getByRole("tab", { name: "概览", exact: true })).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await panel.locator("button:visible, summary:visible, input:visible, select:visible").last().focus();
  await page.keyboard.press("Tab");
  await expect.poll(() => panel.evaluate((node) => node.contains(document.activeElement))).toBe(false);
});

test("A3 native page takes over an open dialog and preserves its secret draft", async ({ page }) => {
  await page.goto("/");
  await page.locator("[data-qm-entry]").click();
  await page.getByRole("dialog", { name: "供应商限额明细", exact: true }).getByRole("button", { name: "设置", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "用量监控", exact: true });
  await dialog.getByRole("tab", { name: "供应商", exact: true }).click();
  await dialog.locator('.qm-page-row[data-supplier="opencode"]').getByRole("button", { name: "配置", exact: true }).click();
  await dialog.getByLabel("API Key", { exact: true }).fill("isolated-draft-key");
  await page.evaluate(() => window.__qmHost.mountSettings());
  const panel = page.locator(".qm-settings-page");
  await expect(panel).toBeVisible();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(panel.getByLabel("API Key", { exact: true })).toHaveValue("isolated-draft-key");
  expect(await page.evaluate(() => localStorage.getItem("dsh-token-quota.ui.v1") ?? "")).not.toContain("isolated-draft-key");
});

test("A3 embedded page restores its host scroll position after supplier configuration", async ({ page }) => {
  await useDisplayFixture(page);
  await page.goto("/?settings");
  await page.locator("#settings").evaluate((node) => Object.assign(node.style, { width: "350px", height: "260px", overflow: "auto" }));
  const panel = page.locator(".qm-settings-page");
  const configure = panel.locator('.qm-supplier-card[data-supplier="deepseek"]').getByRole("button", { name: "配置", exact: true });
  await configure.scrollIntoViewIfNeeded();
  const scrollTop = await page.locator("#settings").evaluate((node) => node.scrollTop);
  expect(scrollTop).toBeGreaterThan(0);
  await configure.click();
  await expect(panel.locator(".qm-page-head")).toContainText("DeepSeek");
  await panel.getByRole("button", { name: "← 返回" }).click();
  await expect(panel.locator(".qm-overview-grid")).toBeVisible();
  await expect.poll(() => page.locator("#settings").evaluate((node) => node.scrollTop)).toBe(scrollTop);
});

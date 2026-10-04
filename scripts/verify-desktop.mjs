/** 在 Windows 安装版中验收插件。只写入独立 DSH_HOME / Chromium 目录。 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { _electron as electron, expect } from "@playwright/test";

const option = (name) => {
  const at = process.argv.indexOf(name);
  return at < 0 ? undefined : process.argv[at + 1];
};
const executable = option("--app") || process.env.DSH_DESKTOP_EXECUTABLE;
if (process.platform !== "win32" || !executable) {
  throw new Error('需要 Windows 安装版：npm run test:desktop -- --app "C:/path/DeepSeek Harness.exe"');
}
const repo = fileURLToPath(new URL("..", import.meta.url));
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const output = resolve(option("--output") || join(repo, ".scratch", `desktop-${stamp}`));
const home = join(output, "home");
const profile = join(home, "profiles", "desktop");
const packageFile = option("--package") && resolve(option("--package"));
const spec = packageFile ? `file:${packageFile.replaceAll("\\", "/")}` : `link:${repo.replaceAll("\\", "/")}`;
await mkdir(profile, { recursive: true });
// 拒绝重用输出目录，以免覆盖此前的配置或证据。
await writeFile(join(profile, "package.json"), JSON.stringify({
  name: "quota-desktop-acceptance", private: true, dependencies: {},
  dsh: { profile: { bundles: ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app"] } },
}, null, 2), { flag: "wx" });
await writeFile(join(profile, "cordis.yml"), "[]\n");
await writeFile(join(profile, "cordis.patch.yml"), [
  "- id: webserver", "  config:", "    host: 127.0.0.1", "    port: 0",
  "- id: ui-settings-account", "  config:", "    version: 1", "    step: done",
  "    completion: skipped", "    developerTools: true", "",
].join("\n"));
const env = { ...process.env, DSH_HOME: home, DSH_AGENTS_HOME: join(output, "agents"), DSH_TELEMETRY_DISABLED: "1" };
// 隔离 profile 不能通过进程环境继承真实供应商凭据。
for (const key of Object.keys(env)) if (/API_?KEY|TOKEN|SECRET|PASSWORD/i.test(key)) delete env[key];
delete env.ELECTRON_RUN_AS_NODE;
const cli = join(dirname(executable), "resources", "app.asar", "dsh", "node_modules", "@deepseek-ai", "dsh-desktop-host", "lib", "cli.js");
const install = spawnSync(executable, ["--expose-internals", cli, "plugin", "--profile", "desktop", "add", spec], {
  env: { ...env, ELECTRON_RUN_AS_NODE: "1" }, cwd: output, windowsHide: true, encoding: "utf8", timeout: 120_000,
});
assert.equal(install.status, 0, install.stderr || "桌面 profile 安装失败");

const report = { startedAt: new Date().toISOString(), status: "running", checks: [], source: packageFile ? "npm-package" : "source-link", supplierQueries: "notRun", supplierQueriesReason: "隔离环境未配置真实供应商凭据，未发送聊天或付费查询。" };
if (packageFile) report.packageSha256 = createHash("sha256").update(await readFile(packageFile)).digest("hex");
const app = await electron.launch({ executablePath: executable, args: [`--user-data-dir=${join(output, "chromium")}`], cwd: output, env, timeout: 30_000 });
let page;
try {
  report.runtime = await app.evaluate(({ app }) => ({ version: app.getVersion(), electron: process.versions.electron, node: process.versions.node }));
  page = await app.firstWindow();
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1180, 800));
  await expect(page.locator(".qm-strip")).toBeVisible({ timeout: 45_000 });
  report.protocol = new URL(page.url()).protocol;
  assert.equal(report.protocol, "dsh-app:");
  const state = () => page.evaluate(async () => {
    const response = await fetch("/api/dsh-token-quota/state?session=");
    if (!response.ok) throw new Error(`state HTTP ${response.status}`);
    return response.json();
  });
  const first = await state();
  assert.equal(first.ok, true);
  report.checks.push("desktop-custom-scheme-state", "sidebar-widget");
  // 对齐用户在插件详情中停用并重新启用组件的触发路径。
  await page.getByText("插件", { exact: true }).click();
  await page.getByText("dsh-token-quota", { exact: true }).first().click();
  const pluginDetail = page.locator('[data-plugin-detail="dsh-token-quota"]');
  await expect(pluginDetail).toBeVisible();
  const componentSwitch = pluginDetail.getByRole("switch", { name: /^(启用组件|Enable part) dsh-token-quota$/ });
  const routeStatus = () => page.evaluate(async () => (await fetch("/api/dsh-token-quota/state")).status);
  for (let cycle = 0; cycle < 3; cycle++) {
    await expect(componentSwitch).toBeChecked();
    await componentSwitch.click();
    await expect(componentSwitch).not.toBeChecked();
    await expect.poll(routeStatus).toBe(404);
    await componentSwitch.click();
    await expect(componentSwitch).toBeChecked();
    await expect.poll(routeStatus).toBe(200);
    assert.equal((await state()).ok, true);
  }
  report.checks.push("plugin-detail-disable-enable-three-cycles");
  await page.screenshot({ path: join(output, "widget.png"),
    mask: [page.getByRole("button", { name: /^(账号菜单|Account menu)$/ })], maskColor: "#f7f8fa" });

  await expect(page.locator("[data-qm-density]")).toHaveAttribute("data-qm-density", "expanded");
  await page.locator("[data-qm-density]").getByRole("button", { name: /^(收起|Collapse)$/ }).click();
  await expect(page.locator("[data-qm-density]")).toHaveAttribute("data-qm-density", "compact");
  await page.reload();
  await expect(page.locator("[data-qm-density]")).toHaveAttribute("data-qm-density", "compact", { timeout: 30_000 });
  await page.locator("[data-qm-density]").getByRole("button", { name: /^(展开|Expand)$/ }).click();
  await expect(page.locator("[data-qm-density]")).toHaveAttribute("data-qm-density", "expanded");
  report.checks.push("sidebar-density-persisted");

  await page.locator("[data-qm-entry]").click();
  const detail = page.getByRole("dialog", { name: /^(供应商限额明细|Supplier quota details)$/ });
  await expect(detail).toBeVisible();
  await expect(detail.getByRole("tab")).toHaveCount(0);
  await expect(detail.locator(".qm-cols")).toBeVisible();
  await expect(detail.locator(".qm-history table")).toHaveCount(1);
  await page.screenshot({ path: join(output, "details.png") });
  await page.keyboard.press("Escape");
  await expect(detail).toHaveCount(0);
  await expect(page.locator(".qm-strip")).toBeFocused();
  report.checks.push("independent-details-and-focus-return");

  await page.locator("[data-qm-entry]").click();
  await detail.getByRole("button", { name: /^(设置|Settings)$/ }).click();
  await expect(detail).toHaveCount(0);
  const settings = page.locator(".qm-settings");
  await expect(settings.getByRole("tab")).toHaveCount(3);
  await settings.getByRole("tab", { name: /^(设置|Settings)$/ }).click();
  await expect(settings.locator('input[max="3600"]')).toBeVisible();
  await settings.locator('input[max="3600"]').fill("75");
  await settings.getByRole("button", { name: /^(保存|Save)$/ }).click();
  await expect(settings.locator(".s-saved")).toBeVisible();
  assert.equal((await state()).poll.intervalSeconds, 75);
  assert.match(await readFile(join(profile, "cordis.patch.yml"), "utf8"), /intervalSeconds: 75/);
  report.checks.push("settings-persist-through-desktop-transport");

  await settings.getByRole("tab", { name: /^(供应商|Suppliers)$/ }).click();
  const rescan = page.waitForResponse(response => response.url().includes("/api/dsh-token-quota/rescan"));
  await settings.locator(".qm-rescan-btn").click();
  const scanned = await (await rescan).json();
  assert.equal(scanned.ok, true);
  assert.equal(scanned.detect.error, null);
  report.checks.push("optional-services-and-rescan");
  await settings.locator(".qm-addable summary").click();
  await settings.locator(".qm-add-row").filter({ has: page.locator(".qm-page-name", { hasText: /^DeepSeek$/ }) }).getByRole("button").click();
  await expect(settings.locator(".qm-advanced")).not.toHaveAttribute("open", "");
  await expect(settings.locator(".qm-quota-preview")).toBeVisible();
  await settings.locator(".qm-inline-toggle input").uncheck();
  await settings.locator(".qm-advanced summary").click();
  await settings.locator('input[max="99"]').fill("76");
  await settings.getByRole("button", { name: /^(保存|Save)$/ }).click();
  await expect(settings.locator(".s-saved")).toBeVisible();
  assert.equal((await state()).suppliers.find(s => s.id === "deepseek").warnPct, 76);
  assert.match(await readFile(join(profile, "cordis.patch.yml"), "utf8"), /warnPct: 76/);
  report.checks.push("supplier-editor-nonsecret-save");
  await page.screenshot({ path: join(output, "settings.png") });
  await page.keyboard.press("Escape");

  await page.getByRole("button", { name: /^(账号菜单|Account menu)$/ }).click();
  await page.getByRole("menuitem", { name: /设置|Settings/ }).click();
  await page.getByRole("button", { name: /^(用量监控|Usage monitor)$/ }).click();
  await expect(page.locator(".qm-settings-page")).toBeVisible();
  await expect(page.locator(".qm-settings-page")).not.toHaveAttribute("role", "dialog");
  await page.locator(".qm-settings-page").getByRole("tab", { name: /^(设置|Settings)$/ }).click();
  await expect(page.locator('.qm-settings input[max="3600"]')).toHaveValue("75");
  await page.screenshot({ path: join(output, "settings-section.png") });
  report.checks.push("native-settings-section");
  await page.keyboard.press("Escape");

  // Windows 桌面收起时侧栏宽度为零，官方布局不保留 Web 的图标栏。
  await page.getByRole("button", { name: /^(收起侧边栏|Collapse sidebar)$/ }).click();
  await expect(page.locator('[data-sidebar-collapsed="true"]')).toBeVisible();
  await expect(page.locator(".qm-strip")).toHaveCount(0);
  await expect(page.locator(".qm-rail")).toBeHidden();
  await page.screenshot({ path: join(output, "collapsed.png") });
  await page.getByRole("button", { name: /^(打开侧边栏|Open sidebar)$/ }).click();
  await expect(page.locator(".qm-strip")).toBeVisible();
  await expect(page.locator("[data-qm-density]")).toHaveAttribute("data-qm-density", "expanded");
  await page.locator("[data-qm-entry]").click();
  await expect(detail).toBeVisible();
  const box = await detail.boundingBox();
  const viewport = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
  assert.ok(box.x >= 0 && box.y >= 0 && box.x + box.width <= viewport.width && box.y + box.height <= viewport.height);
  report.checks.push("desktop-collapse-reopen-and-dialog-bounds");
  await page.screenshot({ path: join(output, "reopened.png") });
  await page.keyboard.press("Escape");
  report.status = "passed";
} catch (error) {
  report.status = "failed";
  report.error = String(error.message);
  await page?.screenshot({ path: join(output, "failure.png") }).catch(() => {});
  throw error;
} finally {
  report.finishedAt = new Date().toISOString();
  await writeFile(join(output, "report.json"), JSON.stringify(report, null, 2) + "\n");
  // 应用退出确认可能阻止 Electron 正常关闭；只清理本脚本启动的隔离进程树。
  let closeTimer;
  const closed = await Promise.race([
    app.close().then(() => true, () => false),
    new Promise(resolve => { closeTimer = setTimeout(() => resolve(false), 10_000); }),
  ]);
  clearTimeout(closeTimer);
  if (!closed && app.process().exitCode === null) {
    spawnSync("taskkill", ["/PID", String(app.process().pid), "/T", "/F"], { windowsHide: true });
  }
  console.log(JSON.stringify({ ...report, output }, null, 2));
}

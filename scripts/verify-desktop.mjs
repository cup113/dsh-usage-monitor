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
const env = { ...process.env, DSH_HOME: home };
delete env.ELECTRON_RUN_AS_NODE;
const cli = join(dirname(executable), "resources", "app.asar", "dsh", "node_modules", "@deepseek-ai", "dsh-desktop-host", "lib", "cli.js");
const install = spawnSync(executable, ["--expose-internals", cli, "plugin", "--profile", "desktop", "add", spec], {
  env: { ...env, ELECTRON_RUN_AS_NODE: "1" }, encoding: "utf8", timeout: 120_000,
});
assert.equal(install.status, 0, install.stderr || "桌面 profile 安装失败");

const report = { startedAt: new Date().toISOString(), status: "running", checks: [], source: packageFile ? "npm-package" : "source-link" };
if (packageFile) report.packageSha256 = createHash("sha256").update(await readFile(packageFile)).digest("hex");
const app = await electron.launch({ executablePath: executable, args: [`--user-data-dir=${join(output, "chromium")}`], env, timeout: 30_000 });
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
  await page.screenshot({ path: join(output, "widget.png"),
    mask: [page.getByRole("button", { name: /^(账号菜单|Account menu)$/ })], maskColor: "#f7f8fa" });

  await page.locator(".qm-strip").click();
  await page.locator(".qm-pop").getByRole("button", { name: /^(详情|Details)$/ }).click();
  const detail = page.getByRole("dialog", { name: /供应商限额明细|Supplier quota details/ });
  await expect(detail).toBeVisible();
  await page.screenshot({ path: join(output, "details.png") });
  await page.keyboard.press("Escape");
  await expect(detail).toHaveCount(0);
  await expect(page.locator(".qm-strip")).toBeFocused();
  report.checks.push("details-and-focus-return");

  await page.locator(".qm-strip").click();
  await page.locator(".qm-pop").getByRole("button", { name: /^(设置|Settings)$/ }).click();
  const settings = page.locator(".qm-settings");
  await expect(settings.locator('input[max="3600"]')).toBeVisible();
  await settings.locator('input[max="3600"]').fill("75");
  await settings.getByRole("button", { name: /^(保存|Save)$/ }).click();
  await expect(settings.locator(".s-saved")).toBeVisible();
  assert.equal((await state()).poll.intervalSeconds, 75);
  assert.match(await readFile(join(profile, "cordis.patch.yml"), "utf8"), /intervalSeconds: 75/);
  report.checks.push("settings-persist-through-desktop-transport");

  const rescan = page.waitForResponse(response => response.url().includes("/api/dsh-token-quota/rescan"));
  await settings.locator(".qm-rescan-btn").click();
  const scanned = await (await rescan).json();
  assert.equal(scanned.ok, true);
  assert.equal(scanned.detect.error, null);
  report.checks.push("optional-services-and-rescan");
  await page.screenshot({ path: join(output, "settings.png") });
  await page.keyboard.press("Escape");

  await page.getByRole("button", { name: /^(账号菜单|Account menu)$/ }).click();
  await page.getByRole("menuitem", { name: /设置|Settings/ }).click();
  await page.getByRole("button", { name: /^(用量监控设置|Quota monitor settings)$/ }).click();
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
  await page.locator(".qm-strip").click();
  await page.locator(".qm-pop").getByRole("button", { name: /^(详情|Details)$/ }).click();
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

/** 使用安装版附带的真实 DSH Web 宿主；不使用浏览器测试壳或日常 profile。 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync } from "node:child_process";
import { chromium, expect } from "@playwright/test";

const option = name => {
  const at = process.argv.indexOf(name);
  return at < 0 ? undefined : process.argv[at + 1];
};
const executable = option("--app") || process.env.DSH_DESKTOP_EXECUTABLE;
if (process.platform !== "win32" || !executable) throw new Error("需要 --app 指定 Windows 安装版，其内置 CLI 用于运行真实 Web 宿主。");
const repo = fileURLToPath(new URL("..", import.meta.url));
const output = resolve(option("--output") || join(repo, ".scratch", `web-${new Date().toISOString().replace(/[:.]/g, "-")}`));
const home = join(output, "home");
const profile = join(home, "profiles", "web");
const packageFile = option("--package") && resolve(option("--package"));
const spec = packageFile ? `file:${packageFile.replaceAll("\\", "/")}` : `link:${repo.replaceAll("\\", "/")}`;
await mkdir(profile, { recursive: true });
await writeFile(join(profile, "package.json"), JSON.stringify({
  name: "quota-web-acceptance", private: true, dependencies: {},
  dsh: { profile: { bundles: ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app"] } },
}, null, 2), { flag: "wx" });
await writeFile(join(profile, "cordis.yml"), "[]\n");
await writeFile(join(profile, "cordis.patch.yml"), [
  "- id: webserver", "  config:", "    host: 127.0.0.1", "    port: 0",
  "- id: ui-settings-account", "  config:", "    version: 1", "    step: done",
  "    completion: skipped", "    developerTools: true", "",
].join("\n"));
const env = { ...process.env, DSH_HOME: home, DSH_AGENTS_HOME: join(output, "agents"), DSH_TELEMETRY_DISABLED: "1", ELECTRON_RUN_AS_NODE: "1" };
for (const key of Object.keys(env)) if (/API_?KEY|TOKEN|SECRET|PASSWORD/i.test(key)) delete env[key];
const cli = join(dirname(executable), "resources", "app.asar", "dsh", "node_modules", "@deepseek-ai", "dsh-desktop-host", "lib", "cli.js");
const report = {
  startedAt: new Date().toISOString(), status: "running", checks: [],
  source: packageFile ? "npm-package" : "source-link", host: "real-dsh-web",
  supplierQueries: "notRun", supplierQueriesReason: "隔离环境未配置真实供应商凭据，未发送聊天或付费查询。",
};
if (packageFile) report.packageSha256 = createHash("sha256").update(await readFile(packageFile)).digest("hex");
let browser, page, child, stdout = "", stderr = "";
try {
  const install = spawnSync(executable, ["--expose-internals", cli, "plugin", "--profile", "web", "add", spec], {
    cwd: output, env, encoding: "utf8", timeout: 120_000, windowsHide: true,
  });
  assert.equal(install.status, 0, install.stderr || "Web profile 安装失败");
  const runtime = spawnSync(executable, ["--expose-internals", cli, "--version"], { cwd: output, env, encoding: "utf8", timeout: 20_000, windowsHide: true });
  assert.equal(runtime.status, 0, runtime.stderr);
  report.runtime = { cli: runtime.stdout.trim(), browser: "Chromium" };
  child = spawn(executable, ["--expose-internals", cli, "web", "--host", "127.0.0.1", "--port", "0", "--no-open"], {
    cwd: output, env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true,
  });
  child.stdout.setEncoding("utf8").on("data", chunk => { stdout += chunk; });
  child.stderr.setEncoding("utf8").on("data", chunk => { stderr += chunk; });
  let startError;
  child.on("error", error => { startError = error; });
  let url;
  await expect.poll(() => {
    if (startError) throw startError;
    if (child.exitCode !== null) throw new Error(`Web 启动提前退出 (${child.exitCode})\n${stderr}`);
    url = /dsh web: (http:\/\/[^\s]+)/.exec(stdout)?.[1];
    return !!url;
  }, { timeout: 45_000 }).toBe(true);
  assert.equal(new URL(url).hostname, "127.0.0.1");
  report.url = new URL(url).origin;
  browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1180, height: 800 } });
  page = await context.newPage();
  await page.goto(url);
  await expect(page.locator(".qm-strip")).toBeVisible({ timeout: 45_000 });
  // 全新 Web profile 的预览版说明需按宿主正常交互关闭。
  await page.getByRole("button", { name: /^(继续|Continue)$/ }).click();
  await page.getByRole("button", { name: /^(稍后配置|Set up later|Skip for now)$/ }).click();
  const state = () => page.evaluate(async () => {
    const response = await fetch("/api/dsh-token-quota/state?session=");
    if (!response.ok) throw new Error(`state HTTP ${response.status}`);
    return response.json();
  });
  assert.equal((await state()).ok, true);
  report.checks.push("real-web-state-and-sidebar");
  await page.screenshot({ path: join(output, "widget.png") });

  await page.locator("[data-qm-density]").getByRole("button", { name: /^(收起|Collapse)$/ }).click();
  await page.reload();
  await expect(page.locator("[data-qm-density]")).toHaveAttribute("data-qm-density", "compact", { timeout: 30_000 });
  // 未配置密钥的真实 Web 宿主在刷新后再次显示接入提示。
  await page.getByRole("button", { name: /^(稍后配置|Set up later|Skip for now)$/ }).click();
  await page.locator("[data-qm-density]").getByRole("button", { name: /^(展开|Expand)$/ }).click();
  await page.locator("[data-qm-entry]").click();
  const popover = page.getByRole("dialog", { name: /^(用量|Usage)$/ });
  await expect(popover).toBeVisible();
  await expect(page.locator(".qm-overlay")).toHaveCount(0);
  const popupBox = await popover.boundingBox(), anchorBox = await page.locator("[data-qm-entry]").boundingBox();
  assert.ok(popupBox.y + popupBox.height <= anchorBox.y && popupBox.x >= 0);
  report.checks.push("sidebar-anchored-usage-popover");
  await page.screenshot({ path: join(output, "usage-popover.png") });
  await popover.getByRole("button", { name: /^(详情|Details)$/ }).click();
  const detail = page.getByRole("dialog", { name: /^(供应商限额明细|Supplier quota details)$/ });
  await expect(detail).toBeVisible();
  await expect(detail.getByRole("tab")).toHaveCount(0);
  await expect(detail.locator(".qm-cols")).toBeVisible();
  await expect(detail.locator(".qm-history table")).toHaveCount(1);
  await page.screenshot({ path: join(output, "details.png") });
  await page.keyboard.press("Escape");
  await expect(detail).toHaveCount(0);
  await expect(page.locator("[data-qm-entry]")).toBeFocused();
  report.checks.push("independent-details-focus-and-density");

  await page.locator("[data-qm-entry]").click();
  await popover.getByRole("button", { name: /^(设置|Settings)$/ }).click();
  await expect(detail).toHaveCount(0);
  const panel = page.getByRole("dialog", { name: /^(用量监控|Usage monitor)$/ });
  await expect(panel.getByRole("tab")).toHaveCount(3);
  await panel.getByRole("tab", { name: /^(设置|Settings)$/ }).click();
  await panel.locator('input[max="3600"]').fill("75");
  await panel.getByRole("button", { name: /^(保存|Save)$/ }).click();
  await expect(panel.locator(".s-saved")).toBeVisible();
  assert.equal((await state()).poll.intervalSeconds, 75);
  assert.match(await readFile(join(profile, "cordis.patch.yml"), "utf8"), /intervalSeconds: 75/);
  report.checks.push("web-nonsecret-config-persisted");

  await panel.getByRole("tab", { name: /^(供应商|Suppliers)$/ }).click();
  const rescan = page.waitForResponse(response => response.url().includes("/api/dsh-token-quota/rescan"));
  await panel.locator(".qm-rescan-btn").click();
  const scanned = await (await rescan).json();
  assert.equal(scanned.ok, true);
  assert.equal(scanned.detect.error, null);
  await panel.locator(".qm-addable summary").click();
  await panel.locator(".qm-add-row").filter({ has: page.locator(".qm-page-name", { hasText: /^DeepSeek$/ }) }).getByRole("button").click();
  await expect(panel.locator(".qm-quota-preview")).toBeVisible();
  await expect(panel.locator(".qm-advanced")).not.toHaveAttribute("open", "");
  await panel.locator(".qm-inline-toggle input").uncheck();
  await panel.locator(".qm-advanced summary").click();
  await panel.locator('input[max="99"]').fill("76");
  await panel.getByRole("button", { name: /^(保存|Save)$/ }).click();
  await expect(panel.locator(".s-saved")).toBeVisible();
  assert.equal((await state()).suppliers.find(s => s.id === "deepseek").warnPct, 76);
  await page.screenshot({ path: join(output, "suppliers.png") });
  report.checks.push("web-supplier-editor-and-rescan");
  await page.keyboard.press("Escape");

  await page.getByRole("button", { name: /^(设置|Settings)$/ }).click();
  await page.getByRole("button", { name: /^(用量监控|Usage monitor)$/ }).click();
  const embedded = page.locator(".qm-settings-page");
  await expect(embedded).toBeVisible();
  await expect(embedded).not.toHaveAttribute("role", "dialog");
  await embedded.getByRole("tab", { name: /^(设置|Settings)$/ }).click();
  await expect(embedded.locator('input[max="3600"]')).toHaveValue("75");
  await page.screenshot({ path: join(output, "settings-section.png") });
  report.checks.push("web-native-settings-reread");
  await page.keyboard.press("Escape");
  report.status = "passed";
} catch (error) {
  report.status = "failed";
  report.error = String(error.message);
  await page?.screenshot({ path: join(output, "failure.png") }).catch(() => {});
  throw error;
} finally {
  await browser?.close();
  if (child?.pid && child.exitCode === null) {
    spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true });
  }
  const redact = value => value.replace(/([?&]token=)[^\s"'<>]+/g, "$1[redacted]");
  await writeFile(join(output, "host.stdout.log"), redact(stdout));
  await writeFile(join(output, "host.stderr.log"), redact(stderr));
  report.finishedAt = new Date().toISOString();
  await writeFile(join(output, "report.json"), JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify({ ...report, output }, null, 2));
}

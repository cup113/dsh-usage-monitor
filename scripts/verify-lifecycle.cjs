/** 使用安装版 Electron 的 Node 模式验证真实 Cordis 生命周期；数据目录必须隔离。 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { spawnSync } = require('node:child_process');

const option = (name) => {
  const at = process.argv.indexOf(name);
  return at < 0 ? undefined : process.argv[at + 1];
};
const executable = option('--app') || process.env.DSH_DESKTOP_EXECUTABLE;
const host = option('--host') || (executable && path.join(path.dirname(executable), 'resources/app.asar/dsh/node_modules'));
const output = path.resolve(option('--output') || '.scratch/lifecycle');
const packageRoot = path.resolve(option('--package-root') || path.join(__dirname, '..'));
if (!process.versions.electron) {
  if (!executable) throw new Error('需要 --app 指向安装版 DeepSeek Harness.exe');
  const env = { ...process.env, ELECTRON_RUN_AS_NODE: '1' };
  for (const key of Object.keys(env)) if (/API_?KEY|TOKEN|SECRET|PASSWORD/i.test(key)) delete env[key];
  const result = spawnSync(executable, [__filename, ...process.argv.slice(2)], {
    env, windowsHide: true, encoding: 'utf8', timeout: 30_000,
  });
  if (result.error) throw result.error;
  const report = JSON.parse(fs.readFileSync(path.join(output, 'report.json'), 'utf8'));
  console.log(JSON.stringify(report, null, 2));
  process.exit(result.status === 0 && report.status === 'passed' ? 0 : 1);
}
if (!host) throw new Error('需要 --host 指向安装版 resources/app.asar/dsh/node_modules');
fs.mkdirSync(output, { recursive: true });
process.env.DSH_HOME = path.join(output, 'home');
const report = { status: 'running', checks: [], startedAt: new Date().toISOString() };
let root;
(async () => {
  const { Context } = require(path.join(host, '@deepseek-ai/cordis/lib/index.js'));
  const web = require(path.join(host, '@deepseek-ai/dsh-host-webserver/lib/index.js'));
  const plugin = await import(pathToFileURL(path.join(packageRoot, 'lib/index.js')).href);
  root = new Context();
  root.reflect.provide('settings', { describe: () => [], update: async () => {} });
  await root.plugin(web.default, { host: '127.0.0.1', port: 0, compression: 'none' });
  const server = root.get('webServer');
  report.runtime = { electron: process.versions.electron, node: process.versions.node };
  const conflict = server.register({ kind: 'exact', path: '/api/dsh-token-quota/refresh', handler: (_req, res) => { res.writeHead(204); res.end(); } });
  const failed = root.plugin(plugin, {});
  await assert.rejects(failed.await(), /duplicate exact route "\/api\/dsh-token-quota\/refresh"/);
  assert.equal((await fetch(`http://127.0.0.1:${server.port}/api/dsh-token-quota/state`)).status, 404);
  assert.equal((await fetch(`http://127.0.0.1:${server.port}/api/dsh-token-quota/refresh`)).status, 204);
  await failed.dispose();
  conflict();
  report.checks.push('failed-activation-rollback-preserves-conflicting-owner');
  for (let cycle = 1; cycle <= 3; cycle++) {
    const fiber = root.plugin(plugin, {});
    await fiber;
    const response = await fetch(`http://127.0.0.1:${server.port}/api/dsh-token-quota/state`);
    assert.equal(response.status, 200);
    assert.equal((await response.json()).ok, true);
    await fiber.restart();
    const restarted = await fetch(`http://127.0.0.1:${server.port}/api/dsh-token-quota/state`);
    assert.equal((await restarted.json()).ok, true);
    await fiber.dispose();
    const disabled = await fetch(`http://127.0.0.1:${server.port}/api/dsh-token-quota/state`);
    assert.equal(disabled.status, 404);
    report.checks.push(`activation-restart-disable-${cycle}`);
  }
  report.status = 'passed';
})().catch(error => {
  report.status = 'failed';
  report.error = error.stack;
}).finally(async () => {
  await root?.fiber.dispose();
  report.finishedAt = new Date().toISOString();
  fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
  // 失败版本可能遗留原生定时器；此进程只承载隔离验收。
  process.exit(report.status === 'passed' ? 0 : 1);
});

# v2.0.2 插件生命周期与重复路由修复

## 故障与根因

用户在真实 Desktop 插件页启用组件时遇到 `webserver: duplicate exact route "/api/dsh-token-quota/state"`。使用安装版内置的真实 Cordis 和 WebServer，在隔离数据目录中先启动插件，再调用 `fiber.restart()`，v2.0.1 稳定出现相同错误。原始失败报告见 [修复前报告](evidence/v2.0.2/lifecycle-red.json)。

该 Cordis 运行时将具有 prototype 的普通 `apply` 函数作为构造函数执行。在此路径中，返回的函数成为构造结果，宿主不会将其作为插件清理函数收集。原实现依赖 `apply` 返回的清理函数，因而停用或重启后路由、定时器和用量存储租约可能遗留。WebServer 的 `register()` 返回清理函数，但不会替调用方自动登记生命周期。

之前 v2.0.1 的 Desktop 九项验收未包含插件页停用／重新启用动作，无法覆盖此故障。本轮在原功能断言之外新增真实插件页开关回归。

## 修复

- 在资源初始化之前通过 `ctx.effect()` 明确登记清理函数，覆盖宿主停用、重启及启动失败。
- 清理函数保持幂等，避免旧实例的清理函数再次执行时移除新实例路由。
- 用量存储租约取得后立即登记释放动作，提前初始化保存定时器变量，覆盖初始化尚未完成时的失败。
- 逐项清理资源，单项报错继续释放其他资源并记录警告。
- 路由注册失败时撤回本实例已经取得的资源，保留错误及其他实例拥有的冲突路由。

新增 `test/lifecycle.mjs` 覆盖构造函数启动、停用后重新启用、旧清理函数重复调用、部分注册失败、单项清理异常、早期初始化失败。`scripts/verify-lifecycle.cjs` 使用安装版内置的真实 Cordis 和 WebServer，支持指定已解包插件目录验收安装包。

## 验证与边界

核心复现命令如下；修复前出现与用户截图相同的重复路由堆栈，修复后通过。

```powershell
npm run test:lifecycle -- --app 'D:/AI/DeepSeek- Harness/DeepSeek Harness.exe' --output '.scratch/lifecycle-check'
```

单元与集成 77/77、Chromium 23/23 通过。真实 Cordis 安装包验收覆盖冲突导致的启动失败回滚，以及三轮启用、重启、停用。真实 Desktop 安装包验收包含原有九项检查及新增插件详情页三轮停用／重新启用，共十项。每次停用均要求状态路由返回 404，重新启用后要求返回 200 且状态有效。真实 Web 五项功能检查继续通过。

Desktop 本轮使用 `.scratch/verify-desktop-lifecycle.mjs` 本地验证副本，完整保留 `scripts/verify-desktop.mjs` 的功能断言，仅跳过截图，报告将截图标为 `notRun`。此前安装版截图超时和重复旧帧问题已有记录，本轮没有 UI 样式改动，不将截图缺失记为视觉验收通过。

所有宿主检查仅使用隔离目录。真实供应商查询、日常 profile 安装为 `notRun`，未关闭或修改用户日常运行的 Desktop。旧进程已有的路由不能由新版本可靠追溯清理，因此升级前须完全退出 DSH，再安装 v2.0.2 并重新启动。

最终安装包为 `.scratch/github-release-v2.0.2/dsh-token-quota-2.0.2.tgz`，SHA-256 为 `e401e447fbf882c6536b56ee4e805c9e1fbe46a3454acc220d0d5df9cdb85443`。对应 [Desktop 发布包报告](evidence/v2.0.2/desktop-release-report.json)、[Web 发布包报告](evidence/v2.0.2/web-release-report.json)、[真实 Cordis 发布包报告](evidence/v2.0.2/lifecycle-release-report.json)。该归档解包后单元与集成 77/77 通过。

解包目录首次运行 Chromium 时，测试壳直接从该目录的 `node_modules` 读取 React 静态资源，但当时仅通过父目录解析到了 Node 依赖，尚未安装解包目录本地依赖。静态读取失败后测试服务器触发 `ERR_HTTP_HEADERS_SENT`，该轮 23 项失败，保留 [首次失败摘要](evidence/v2.0.2/package-browser-initial-failure.json)，原始 traces 在本地 `.scratch/github-release-v2.0.2/package-browser-initial-failure/`。此失败属于测试环境准备，不记为成功；使用当前锁文件执行 `npm ci --ignore-scripts` 后复验 23/23 通过，未修改产品代码或断言。[复验摘要](evidence/v2.0.2/package-browser-report.json)及本地 `.scratch/github-release-v2.0.2/package-browser-final.log` 保留结果。

GitHub 上传沿用用户已有授权，发布新版本，不覆盖 v2.0.1。远端引用、Release 元数据和附件下载校验单独记录。

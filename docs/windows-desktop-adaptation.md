# Windows 桌面适配记录

日期：2026-10-03（Asia/Shanghai）。本次是 v1.4.0 工作区的兼容性修改，未发布新版本。

## 上游与安装环境

- 官方仓库：<https://github.com/deepseek-ai/deepseek-harness>。
- 阅读基线：`639ed015397290b3745d163aafe02ffee4aa3f84`。
- 本机安装版：DeepSeek Harness Desktop `0.2.0-rc.2`，Electron `44.0.0`，内置 Node.js `24.18.1`。
- 插件通过桌面安装包自带 CLI 安装到 `desktop` profile；保留 `platform: web`，使用桌面与 Web 共用的客户端加载路径。

官方源码依据：

| 契约 | 固定版本源码 | 适配结论 |
|---|---|---|
| 桌面插件安装 | [Desktop README](https://github.com/deepseek-ai/deepseek-harness/blob/639ed015397290b3745d163aafe02ffee4aa3f84/apps/desktop/README.md) | 使用安装版 CLI 与 `desktop` profile，安装后重开应用。 |
| 桌面文档与请求转发 | [web-document.ts](https://github.com/deepseek-ai/deepseek-harness/blob/639ed015397290b3745d163aafe02ffee4aa3f84/apps/desktop/src/web-document.ts)、[main.ts](https://github.com/deepseek-ai/deepseek-harness/blob/639ed015397290b3745d163aafe02ffee4aa3f84/apps/desktop/src/main.ts) | `dsh-app:` 页面经桌面主进程转发到本机宿主；插件保留相对路径与现有同源限制。 |
| 侧栏布局 | [SidebarRoot.tsx](https://github.com/deepseek-ai/deepseek-harness/blob/639ed015397290b3745d163aafe02ffee4aa3f84/packages/client/ui-sidebar/src/client/SidebarRoot.tsx)、[AppFrame.tsx](https://github.com/deepseek-ai/deepseek-harness/blob/639ed015397290b3745d163aafe02ffee4aa3f84/packages/client/ui-layout/src/client/AppFrame.tsx) | `sidebar.footer.action` 仍可用；Windows 收起侧栏后宽度为零，不保留 Web 图标栏。 |
| 当前显示会话 | [ui-session/index.ts](https://github.com/deepseek-ai/deepseek-harness/blob/639ed015397290b3745d163aafe02ffee4aa3f84/packages/client/ui-session/src/client/index.ts) | 读取公开快照中的 `retainedBy.mainView`；不将后台保留的会话当作当前显示页。 |
| 账户余额查询 | [deepseek-account-platform/details.ts](https://github.com/deepseek-ai/deepseek-harness/blob/639ed015397290b3745d163aafe02ffee4aa3f84/packages/credentials/deepseek-account-platform/src/details.ts) | 桌面账户授权与 API Key 的认证路径不同，不把登录凭证发送到 API Key 余额接口。 |

## 修改范围

1. 兼容旧版 `sessions.list.current` 与 0.2 版 `sessions.list.byId`。仅当主视图会话唯一时使用其 ID；空页、后台会话和导航歧义均发送显式空会话参数，避免回退到全局最近调用。
2. 补齐声明 `settings.section` 的 `ui-settings-general` 客户端加载依赖，使原生设置入口按宿主契约注册。
3. 可选服务缺失时只使用 `ctx.get()` 的结果，避免回退到未注入的 `ctx.credentials` 属性而抛错。
4. 详情和设置关闭后，将键盘焦点恢复到侧栏组件，避免返回已经卸载的弹出菜单按钮。
5. 设置页清理过时的 `settings.yaml` 说明及内部设计文案。
6. 为 `deepseek-account` 路由保留独立诊断，禁止仅凭 API 主机名误识别为普通 API Key 路由。

不新增第二个 DeepSeek 余额供应商。账户与 API Key 属于同一账户时，在现有 DeepSeek 页面填写 API Key 即可。仅有桌面登录态时，插件会说明凭据要求，不将未知余额视为零。直接读取登录账户的平台钱包未纳入本次实现。

## 验证方法

`scripts/verify-desktop.mjs` 启动真实 Windows 安装版，创建独立的 `DSH_HOME`、`desktop` profile 与 Chromium 用户目录。隔离 profile 显式配置 `host: 127.0.0.1`、`port: 0`，可与日常桌面应用并存。安装可以使用源码链接或 `npm pack` 产物；报告中区分二者，并记录安装包 SHA-256。

每轮输出目录独立，包含 `report.json` 和截图。脚本不配置真实供应商密钥，不发送聊天消息。真实安装版验收与模拟供应商测试分别记录。

```powershell
npm test
npm run test:browser
npm run test:pack
npm run test:desktop -- --app 'D:\AI\DeepSeek- Harness\DeepSeek Harness.exe' --package 'D:\path\dsh-token-quota-1.4.0.tgz' --output '.scratch\desktop-package-check'
```

## 验证结果

| 验证层 | 结果 | 范围 |
|---|---|---|
| 单元与宿主集成 | 67/67 通过 | 新旧会话隔离、可选服务、账户类型、供应商解析、配置、调度和存储。供应商响应为模拟数据。 |
| Chromium | 7/7 通过 | 表单保存失败、编辑身份、阈值、宽栏焦点恢复、Web 窄栏及键盘交互。 |
| Windows 安装版，源码链接 | 7/7 检查通过 | `dsh-app:` 请求、侧栏、详情与焦点、设置持久化、重新扫描、原生设置页、侧栏收起和恢复。 |
| Windows 安装版，压缩包 | 7/7 检查通过 | 报告记录产物哈希、运行时版本及逐项结果；与源码链接检查同一组能力。 |
| 真实供应商余额与计费用量 | `notRun` | 未调用真实余额接口，也未发送付费聊天请求。 |

源码链接成功证据：`.scratch/desktop-acceptance-04/report.json`。最终压缩包证据另存于 `docs/evidence/windows-desktop/`；测试输出目录内的原始日志与截图保留在本地，不包含在安装包中。

## 保留的失败与修复

- 早期隔离启动使用固定端口，与仍在运行的桌面后台进程冲突。后续隔离 profile 改用系统分配端口，不修改日常 profile 的端口。
- 首次动态端口配置遗漏 `host`，导致宿主启动失败。补齐 `host: 127.0.0.1` 后通过。
- `desktop-acceptance-01` 捕获弹层关闭后的焦点丢失；新增浏览器回归，修复持久入口焦点恢复后通过。
- `desktop-acceptance-02` 错将 Web 图标栏预期用于 Windows 桌面。依据官方零宽折叠契约改为验证隐藏和展开恢复，未修改上游布局。
- `desktop-acceptance-03` 使用了错误的中文展开按钮名称，等待超时；按官方文案“打开侧边栏”修正后，`desktop-acceptance-04` 全部通过。
- `desktop-package-acceptance-final` 在设置页截图时超时；此前五项功能检查已经完成。本轮仍记为失败，另用独立目录复验最终产物。

上述失败保留各自报告，不计入通过结果。Windows 桌面适配通过，不代表所有供应商的真实账户查询已经验收。

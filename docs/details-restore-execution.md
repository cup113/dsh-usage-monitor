# 详情布局恢复与供应商扫描修复记录

日期：2026-10-04（Asia/Shanghai）。源码版本：2.0.1。实施基线：GitHub `main` 的 `c0009b865bb979bd48f87e57b7a10d716f9df06d`。

## 请求与实现

侧栏入口恢复 v1.4.0 的独立供应商限额明细弹窗，沿用当前主题配色、按钮、完整／紧凑侧栏和共享数据请求。用户确认通过详情中的“设置”按钮进入现有三页签面板。

详情按已添加供应商分栏展示各周期与币种指标，保留零值、未知值、失败后的旧数据和成功数据时间。刷新历史恢复为包含时间、供应商、结果、主指标、备注的表格，最多展示最近 50 条。窄窗口在供应商栏和历史表内部横向滚动；关闭后焦点返回侧栏入口。

截图中的扫描异常为 `cannot get required service "settings" in inactive context`。回归使用实际插件装配、异步凭据解析和严格服务属性代理，复现 `settingsUserHas → include → detectHarnessSuppliers` 的相同调用栈。安装版 Cordis 的 `@deepseek-ai/cordis/lib/index.js` 确认严格属性访问存在该错误分支，并提供公开 `get(name)` 查询接口。

修复将宿主设置读取与写入统一改为 `ctx.get("settings")`，仅对没有 `get` 的旧式宿主保留属性访问。供应商探测使用查询取得的设置服务。服务缺失时明确报告扫描失败并保留最近成功目录，恢复后重扫清除错误；未通过隐藏错误文案或返回空目录处理问题。

主要代码：`lib/client.js`、`lib/detect.js`、`lib/index.js`。README、术语文档、验证脚本和测试入口同步更新。

## 验证

| 验证层 | 结果 | 范围 |
| --- | --- | --- |
| `npm test` | 73/73 通过，无跳过 | 设置服务访问、缺失与恢复、供应商识别、配置保存、迁移、共享请求生命周期、会话隔离及存储。 |
| `npm run test:browser` | 完整 23/23；最后键盘修正后针对性 6/6 通过 | 独立详情入口、分栏、最近 50 条历史表格、设置跳转、焦点、明暗主题、窄窗口、草稿和保存身份保护。 |
| `npm run test:pack` | 通过 | 46 个文件；归档内 46/46 文件与工作区逐字节一致。 |
| 安装版 Desktop，候选包 | 9/9 通过 | DSH 0.2.0-rc.2，Electron 44.0.0，Node 24.18.1；独立 profile，真实 `dsh-app:` 请求、详情、设置持久化、重扫、原生设置和侧栏恢复。 |
| 真实 DSH Web，候选包 | 5/5 通过 | 独立 Web profile 和 Chromium；真实 HTTP 宿主，详情与焦点、设置保存、重扫、原生设置重读。 |
| 真实供应商账户查询 | `notRun` | 隔离环境未配置真实凭据，未发送聊天或付费查询。 |
| 用户日常 profile 的安装与复验 | `notRun` | 本次验证仅安装到隔离 profile，未替换日常插件。 |

修复前 `node --test test/desktop-services.mjs` 的新增用例复现同一异常；修复后该用例通过，并验证缺失服务不能误报成功。详情浏览器回归在实现前因缺少独立详情弹窗失败，实现后通过。

首次完整回归中，迁移夹具替换了 `ctx.settings`，其 `get` 实现却仍返回旧服务，导致故障注入失效。修正夹具使服务查询跟随替换后，原有“不可描述时不得写入且必须记录警告”断言通过。旧浏览器入口预期也按用户确认的详情 → 设置路径更新，原有草稿与在途保存保护断言保留。

首次安装版 Desktop 验证在详情已打开后发生 `page.screenshot: Timeout 30000ms exceeded`，该轮记为失败。使用相同候选包及原验证脚本，在新的隔离目录复验 9/9 通过，保留首次失败报告，不计入成功结果。

最后补齐详情历史摘要的键盘焦点，验证关闭按钮后按 Tab 可到达摘要，并可用 Enter 展开表格。重新打包后，最终包的 Desktop 9/9 与 Web 5/5 再次通过。最终 Desktop 使用保留全部原功能断言的本地验证副本 `.scratch/verify-desktop-native.mjs`，仅将截图采集改为 Electron 原生 `webContents.capturePage`；报告明确记录截图方法。产品运行逻辑与数据断言未因截图超时改变。

## 产物与证据

候选包：`.scratch/details-restore-candidate-20261004/dsh-token-quota-2.0.1.tgz`。

SHA-256：`a698216569ba45bbad89ff4ad759c2e7c1b2ae6bb1f246d0d47769c17199062b`。最终 Desktop 和 Web 报告记录同一包哈希。首次失败报告属于键盘修正前的中间候选包，保留其原始哈希。

- [Desktop 成功报告](evidence/v2.0.1/desktop-report.json)
- [Web 成功报告](evidence/v2.0.1/web-report.json)
- [Desktop 首次失败报告](evidence/v2.0.1/desktop-initial-failure.json)
- [详情布局截图（模拟供应商数据）](evidence/v2.0.1/details-fixture.png)

模拟截图中的余额、用量、失败信息和历史记录仅用于界面验收，不属于真实账户结果。最终真实宿主原始截图与隔离配置保留在本地 `.scratch/details-restore-desktop-final-20261004/` 和 `.scratch/details-restore-web-final-20261004/`。

本轮完成本地源码修复、候选打包和上述验证。未提交、推送、创建 tag 或发布 Release。

## GitHub 发布准备与复验

2026-10-04，用户另行授权上传 GitHub。前述未提交、未发布描述实施阶段的边界，本阶段准备提交、推送 `main`、创建 annotated tag `v2.0.1`，并上传 GitHub Release。

README 安装示例已更新为 v2.0.1。发布安装包为 `.scratch/github-release-v2.0.1/dsh-token-quota-2.0.1.tgz`，SHA-256：`99f9007d6ce05c6899697d429ca6e2a7faf670efc59563831a1f23c742310d10`。

该归档在独立目录解包后，使用当前锁文件安装相同依赖，单元与集成 73/73、完整 Chromium 23/23 通过。发布归档的真实 Desktop 功能检查 9/9 与 Web 5/5 通过，报告分别为 [Desktop 发布包报告](evidence/v2.0.1/desktop-release-report.json) 和 [Web 发布包报告](evidence/v2.0.1/web-release-report.json)。版本元数据三处一致，运行时模块语法与打包清单检查通过。

本次 Desktop 原生截图中，详情、设置等多个阶段的 PNG 哈希相同，存在重复旧帧，不能作为各阶段的视觉验收证据。Desktop 报告的九项结论来自实际 DOM 交互、真实宿主路由、持久化和布局边界断言；视觉布局证据来自 Chromium 测试和真实 Web 截图。重复帧原始文件保留在本地，未作为 Release 附件上传。此前的截图超时失败报告继续保留。

发布资产限定为插件包、Git tag 对应源码快照和 `SHA256SUMS.txt`。真实供应商查询及日常 profile 安装仍为 `notRun`。GitHub 的远端引用、Release 元数据和附件下载校验将在上传后单独记录。

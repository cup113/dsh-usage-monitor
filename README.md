# dsh-token-quota

DeepSeek Harness 用量监控插件。查看当前会话对应供应商的周期限额、账户余额、报告费用和今日 Token 用量，支持 Windows 桌面端与 Web 界面。

当前版本：**v2.0.3**。要求 **DSH ≥ 0.1.7-rc.2**；真实桌面及 Web 验收环境为 **DSH 0.2.0-rc.2**。

[GitHub 下载](https://github.com/shxtmaker/dsh-token-quota/releases/latest) · [问题反馈](https://github.com/shxtmaker/dsh-token-quota/issues)

## v2.0.3 更新

- 点击侧栏打开贴在卡片上方的用量浮卡，显示供应商主指标、查询状态、刷新间隔和上次刷新时间。
- 浮卡底部提供“详情”“设置”“关闭”；完整供应商明细和现有配置面板继续保留。
- 浮卡适配完整、紧凑和图标侧栏，支持再次点击、Esc 和外部点击关闭，随窗口变化调整位置。

## v2.0.2 更新

- 修复停用、重新启用和宿主重启插件时的 `webserver: duplicate exact route` 启用失败。
- 启动失败时释放已登记的资源；某项清理报错不会阻止其他资源释放。

## v2.0.1 更新

- 侧栏单击恢复独立「供应商限额明细」弹窗，按 v1.4.0 分栏展示已添加供应商与周期指标，刷新历史恢复为表格，沿用当前主题配色和按钮样式。
- 详情中的「设置」按钮进入现有概览、供应商、设置面板；保留完整／紧凑侧栏和显示偏好。
- 修复供应商扫描中的 `cannot get required service "settings" in inactive context` 错误；设置服务暂不可用时保留最近成功目录，恢复后可重新扫描。

## v2.0.0 更新

- 侧栏支持完整与紧凑显示，单击直接打开概览，显示偏好自动保存。
- 用量监控面板提供「概览」「供应商」「设置」三个页签，侧栏入口与宿主设置入口使用相同内容。
- 概览支持需关注筛选、自适应一列或两列布局，保留各周期与币种的独立指标。
- 配置编辑保留未保存草稿，提供放弃修改确认；保存失败保留输入，避免旧请求覆盖新的编辑内容。
- 查询失败时保留上次成功数据并标明状态；未知值与真实零值分别显示。
- 适配 Windows 桌面端的当前会话选择、原生设置入口和侧栏收起／恢复。

## 安装

从 Release 下载 **`dsh-token-quota-2.0.3.tgz`**。该文件是插件安装包，`dsh-token-quota-2.0.3-source.tar.gz` 是源码包。插件包不包含 DeepSeek Harness；首次安装可能需要联网下载依赖。

### Windows 桌面端

先启动一次 DeepSeek Harness Desktop，完成初始化后完全退出。使用安装目录自带的 CLI，将插件添加到 **`desktop` profile**。请按实际位置修改路径。

```powershell
$desktopCli = 'D:\AI\DeepSeek- Harness\resources\runtime\cli\bin\dsh.cmd'
$archivePath = (Resolve-Path './dsh-token-quota-2.0.3.tgz').Path
& $desktopCli plugin --profile desktop add "file:$archivePath"
& $desktopCli plugin --profile desktop list --depth 0
```

重新打开桌面应用，展开左侧栏即可看到用量组件；也可从「设置 → 用量监控」进入。安装到 `web` profile 的插件不会自动出现在桌面端。桌面侧栏收起后组件随侧栏隐藏，展开后恢复。

### Web / CLI

先安装 DeepSeek Harness，确认 `dsh --version` 能正常运行。以下示例使用 `web` profile；使用其他 profile 时请替换名称。

Linux / macOS：

```bash
dsh plugin --profile web add "file:$(pwd)/dsh-token-quota-2.0.3.tgz"
dsh --profile web
```

Windows PowerShell：

```powershell
$archivePath = (Resolve-Path './dsh-token-quota-2.0.3.tgz').Path
dsh plugin --profile web add "file:$archivePath"
dsh --profile web
```

若旧版本已提示重复路由，先完全退出 DSH，再安装 v2.0.3 并重新启动，以清除当前进程中遗留的旧路由。

安装或升级前，请先结束当前任务并退出对应 DSH 实例。压缩包升级时，用新包重新执行 `add` 命令，然后重启 DSH 并刷新 Web 页面。

### 从源码安装

```bash
git clone https://github.com/shxtmaker/dsh-token-quota.git
cd dsh-token-quota
npm ci
dsh plugin --profile web add "link:$(pwd)"
dsh --profile web
```

PowerShell 中将链接安装命令替换为：

```powershell
$pluginDirectory = (Get-Location).Path
dsh plugin --profile web add "link:$pluginDirectory"
```

链接安装直接使用源码目录，请保留该目录及其依赖。更新时执行 `git pull --ff-only` 和 `npm ci`，再重启 DSH。

## 开始使用

1. 单击侧栏组件打开用量浮卡，点击「设置」，再进入「供应商」页签。
2. 点击「重新扫描」，识别 Harness 已配置的普通 API Key；需要更高权限凭据的供应商请手动配置。
3. 打开供应商配置，填写必要字段、启用供应商并保存。秘密字段留空会保留旧值。
4. 使用「测试连接」检查已保存配置，或返回概览刷新数据。
5. 需要调整查询频率或本地用量保留期时，进入「设置」并保存。

**DeepSeek 桌面账户登录凭证与 API Key 不可互换。** 仅登录桌面账户时，请在现有 DeepSeek 供应商配置中填写同一账户的 API Key，或配置 Harness 的 DeepSeek API Key 路由后重新扫描。

## 侧栏与面板

完整侧栏显示当前会话最近调用的供应商与模型、主指标、对应窗口的重置时间及今日用量。紧凑侧栏保留供应商与主指标。独立箭头切换显示状态，偏好保存在当前浏览器；宽度不足时自动使用紧凑显示，恢复宽度后恢复用户选择。

单击侧栏打开用量浮卡，查看已添加供应商的主指标与查询状态。浮卡贴在侧栏卡片上方，窗口变化时自动调整位置；再次点击侧栏、按 Esc、点击外部或“关闭”均可收起。

点击浮卡中的“详情”打开完整明细。已添加供应商各占一栏，各周期和币种分别展示；窄窗口可横向滚动。默认收起的刷新历史表格最多展示最近 50 条。点击“设置”进入配置面板；宿主“设置 → 用量监控”也可直接进入该面板。

| 页签 | 内容 |
| --- | --- |
| 概览 | 今日用量、已添加与需关注数量、筛选、供应商指标和默认收起的刷新历史。 |
| 供应商 | 已添加目录、启用开关、配置入口、重新扫描，以及默认收起的可添加目录。 |
| 设置 | 查询间隔、用量保留期和侧栏显示偏好。 |

查询间隔默认 **60 秒**，范围 **10–3600 秒**；用量保留期默认 **7 天**，范围 **1–90 天**。后台刷新及页签切换保留编辑草稿；插件内部返回、取消或关闭时，会提示放弃未保存修改。宿主直接离开原生设置分区会销毁面板，无法保留未保存草稿。

## 数据含义

- **今日用量**：当前供应商通过 Harness 产生的当日 Token 用量，按宿主本地日统计。独立 CLI 或其他应用中的调用不计入。
- **周期限额**：百分比表示已用比例；侧栏主指标选取已用比例最高的有效窗口，重置时间对应同一窗口。
- **余额**：逐币种显示，不换算、不相加。
- **报告费用与报告用量**：保留供应商报告的周期，与本地今日 Token 统计分别展示。
- **未知与零值**：缺失或未知显示 `—`，真实零值显示 `0`；当前会话尚无调用时显示「暂无调用」。
- **更新失败**：有旧数据时显示「更新失败 · 上次数据」及可用的成功数据时间；没有旧数据时显示「暂时无法获取」。

切换会话不会借用其他会话的供应商。失败刷新保留同一配置下的旧结果；修改查询配置后清除该供应商的旧结果。

## 支持的供应商

| 供应商 | 查询内容 | 凭据 | 配置方式 |
| --- | --- | --- | --- |
| DeepSeek | 账户余额，保留多币种 | 普通 API Key | 自动识别或手动 |
| OpenRouter | 当前 Key 周期额度及今日费用 | 普通 API Key | 自动识别或手动 |
| OpenRouter 账户 | 账户 credits | Management Key | 手动 |
| OpenAI 组织 | 最近完整 UTC 日的用量与费用 | 组织 Admin Key | 手动 |
| Anthropic 组织 | 组织用量与费用 | 组织 Admin Key | 手动 |
| Moonshot 国内／国际 | 账户余额 | 普通 API Key | 自动识别或手动 |
| Z.ai／智谱 Coding Plan | 套餐窗口限额 | 普通 API Key | 自动识别或手动 |
| MiniMax 国内／国际 | Token Plan 窗口限额 | 普通 API Key | 自动识别或手动 |
| OpenCode（兼容来源） | 5 小时、周、月窗口及 allowance | 普通 API Key／OAuth | 自动识别或手动 |
| Command Code（兼容来源） | 5 小时、周窗口及套餐月额度 | 普通 API Key | 自动识别或手动 |

普通 API Key、Management Key 与 Admin Key 分别配置。插件不会将普通聊天密钥用于组织管理接口，也不会覆盖手动填写的密钥或重新启用显式关闭的供应商。

官方查询仅接受对应的 HTTPS 主机与已知基础路径；不符合要求的地址不会发送请求。OpenCode 与 Command Code 使用兼容接口，其可用性取决于供应商接口。表格表示插件支持的查询能力，不代表所有真实账户均已完成验证。

## 数据保存与升级

配置保存在对应 profile 的插件行配置中；秘密字段使用宿主的秘密字段机制。界面中秘密字段留空表示保留，清除时需编辑 `$DSH_HOME/profiles/<profile>/cordis.patch.yml` 中 `id: dsh-token-quota` 对应的配置。

本地 Token 用量按「供应商 × 小时」保存至 `$DSH_HOME/dsh-token-quota/usage.json`，按保留期修剪。刷新历史仅保存在内存中，重启后清空。

从旧版升级时，插件会在当前行尚无用户配置的条件下读取旧 `settings.yaml` 或 `settings.yaml.imported` 中的 `dsh-token-quota`／`quota-monitor` 配置，迁移后保留来源文件。旧用量目录 `quota-monitor` 仅在新目录不存在时迁移。

**v1.1.1 及更早版本用户**：旧插件名为 `dsh-usage-monitor` 或 `dsh-quota-monitor`。先用 `dsh plugin --profile <profile> list --depth 0` 确认，再移除旧包并安装新包，避免同时运行。

## 限制

- 仅观测经过 Harness 的调用；本机 Codex CLI 登录状态和独立 CLI 用量不在范围内。
- 供应商未返回重置时间时，不推算或补造时间；无限额度和未知余额保留未知。
- 没有多日趋势界面；本地用量统计与供应商账单可能因周期、时区和统计范围不同而不同。
- 真实供应商余额、付费调用及 Admin／Management Key 账户需要使用实际凭据另行验证。
- 当前 HTTP 接口面向本机同源访问；反向代理的公开来源配置需另行处理。
- 用量文件损坏或版本不支持时保留原文件并提示错误；退出时无法写入的增量不能保证保存。

## 开发与验证

```bash
npm ci --ignore-scripts
npm test
npx playwright install chromium
npm run test:browser
npm run test:pack
npm pack
```

真实宿主验收使用独立数据目录与 profile，不修改日常配置：

```powershell
npm run test:desktop -- --app 'C:/path/DeepSeek Harness.exe' --package 'C:/path/dsh-token-quota-2.0.3.tgz' --output '.scratch/desktop-v2-check'
node scripts/verify-web.mjs --app 'C:/path/DeepSeek Harness.exe' --package 'C:/path/dsh-token-quota-2.0.3.tgz' --output '.scratch/web-v2-check'
npm run test:lifecycle -- --app 'C:/path/DeepSeek Harness.exe' --output '.scratch/lifecycle-v2-check'
```

输出目录需为未使用过的目录。供应商解析测试使用模拟响应；真实 Desktop 与 Web 验收检查安装、界面、配置持久化和重新扫描，不发送聊天消息或配置真实供应商密钥。

[桌面兼容性说明](docs/windows-desktop-adaptation.md) · [侧栏与设置实施记录](docs/sidebar-settings-iteration-plan.md)

## 许可证

MIT。

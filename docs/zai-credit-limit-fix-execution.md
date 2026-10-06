# v2.0.5 智谱／Z.ai Coding Plan 窗口修复

## 故障复现与根因

用户报告智谱 Coding Plan 供应商显示为「暂时无法获取」。验证日期 2026-10-06（Asia/Shanghai），用用户 profile 中 `zai-cn` 实际配置的密钥直接请求官方端点：

```
POST https://open.bigmodel.cn/api/monitor/usage/quota/limit   → HTTP 200
{"code":200,"msg":"Operation successful","data":{"limits":[
  {"type":"CREDIT_LIMIT","unit":3,"number":5,"usage":2000,"currentValue":0,"remaining":2000,"percentage":0},
  {"type":"CREDIT_LIMIT","unit":6,"number":1,"usage":10000,"currentValue":1533,"remaining":8466,
   "percentage":15,"nextResetTime":1791781957965}],
 "level":"lite"},"success":true}
```

密钥与网络都正常（`success:true`、`code:200`），两行窗口的类型名都已是 `CREDIT_LIMIT`。调用插件自己的查询入口复现故障：

```
node .scratch/zai-probe.mjs <zai-cn 密钥> zai-cn
{ "state": "err", "error": { "code": "no-data", "message": "未解析到已公开的 Coding Plan 窗口" } }
```

`zaiQuery` 只接受 `TOKENS_LIMIT` 与 `TIME_LIMIT`，两行都被 `continue` 跳过，`entries` 为空后报 `no-data`；客户端按 `state === "err"` 显示「暂时无法获取」，详情附上该错误文案。

这是上游改名而非本插件独有的问题：`TOKENS_LIMIT` → `CREDIT_LIMIT` 的改名与「窗口身份由 `unit` 而非数组位置决定」在第三方实现中已被记录（[ai-usagebar `zai/types.rs`](https://docs.rs/ai-usagebar/1.12.0/src/ai_usagebar/zai/types.rs.html)、[sub2api#7470](https://github.com/Wei-Shaw/sub2api/issues/7470)）。`test/smoke.mjs` 的夹具把旧拼写写成了规格，因此改名后测试仍全绿。

补充发现同一条查询路径上的第二个缺陷：供应商把业务失败放在 HTTP 200 的响应体里（`{"code":401,"msg":"token expired or incorrect","success":false}`），而 `httpJson` 只看 HTTP 状态码。用一把无效密钥实测得到 `schema: Coding Plan 响应缺少 data.limits`——密钥失效会被误报成解析失败。

## 修复

- 用量桶同时接受 `TOKENS_LIMIT` 与 `CREDIT_LIMIT`：滚动发布期一行一个拼写时都能读取，两者也不互相当成陌生态。
- 窗口身份改由 `unit` 判定（3 = 5 小时窗口，6 = 周窗口），不依赖数组位置；展示顺序固定为 5 小时 → 周 → 月度 MCP 上限。`unit` 未知的桶丢弃而不是套用别的标签。
- 新增周窗口，并下发供应商公布的 `nextResetTime`（epoch 毫秒）作为 `reset`／`resetAt`；没有该字段时保持 `—`／`null`，不伪造时刻。
- 重复窗口（同一 `unit` 的两种拼写也算）如实报 `schema`；有用量桶却一个 `unit` 都认不出时报「供应商已改版」，不退化成「没有窗口」。
- 业务失败改按响应信封判定：`success:false` 或非 200 的 `code` 时，401／403 归 `auth`，其余归 `schema` 并带上供应商的 `msg`。
- 百分比取整后再比较，保证 `headline` 的 `pct` 一定等于某个条目的 `pct`，不会指向另一个窗口。

## 验证

| 验证层 | 命令 | 结果 |
| --- | --- | --- |
| 数据层冒烟 | `node test/smoke.mjs` | 通过；`zai` 三个窗口 0%／15%／10%，`zai-cn` 旧拼写 + 乱序 7%／42% |
| 源码单元与集成 | `node --test test/*.mjs` | 87/87 通过，0 失败，无跳过 |
| 打包完整性 | `npm run test:pack` | 通过：49 个文件，177,413 字节 |
| 语法检查 | `node --check lib/*.js` | 10/10 通过 |
| 空白检查 | `git diff --check` | 无空白错误 |
| 真实账户 | 插件查询入口 + `zai-cn` 真实密钥 | `state: ok`；5 小时 0%、周 15%（1533/10000），周重置 2026-10-12 13:12 |
| 源码 Chromium | `npm run test:browser` | 25/25 通过（补装 chromium 与 chromium headless shell 后，33.3s） |

新增回归覆盖：`test/provider-contracts.mjs` 四项（按 `unit` 而非数组位置分类、未知 `unit` 丢弃而不误标、同窗口两种拼写判为重复、200 体内业务 401 归 `auth` 而其它业务失败归 `schema`）；`test/smoke.mjs` 改用实测载荷并覆盖旧拼写混用与乱序。

## 边界与交付

- 未执行：真实 DSH 宿主安装包验收（Desktop／Web／Cordis 隔离目录），以及发布流程里的安装包产物二次自测（`npm pack` 解包后重跑单元与浏览器用例）。
- 首次 `npm run test:browser` 因本机缺 `chromium_headless_shell-1243` 无法启动（25 项均在 `browserType.launch` 失败），补装 chromium 与 headless shell 后 25/25 通过；判定日志保存在 `.scratch/browser-source.log`。
- Z.ai 国际站（`api.z.ai`）未取得真实响应：本机经 `HTTPS_PROXY` 访问时 TLS 握手被中断，因此国际站与国内站共用同一实现这一点只由代码路径保证，未由真实响应佐证。
- 真实账户只验证了 `level: lite` 的智谱账户（两个用量窗口，无 `TIME_LIMIT`）。月度 MCP 上限、更高级别套餐与其它窗口组合仍只有夹具覆盖。
- 自动填入是首次扫描时把宿主密钥拷贝进插件设置：轮换密钥后需要手动重填或清空该供应商的密钥，本轮不改这一语义。
- 交付：注解标签 `fork-v2.0.5` 与 `main` 一并推送到 fork 远端 `origin`（`cup113/dsh-usage-monitor`）。标签带 `fork-` 前缀，避免与上游 `shxtmaker/dsh-token-quota` 的 `vX.Y.Z` 标签重名；不推上游、不创建 GitHub Release。

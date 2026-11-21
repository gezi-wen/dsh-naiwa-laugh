# Changelog

## [0.1.1] - 2026-11-21

### Security
- 插件自己的 HTTP 路由（`/dsh-naiwa` 前缀：播放器脚本、音效、manifest、状态）补上访问检查，做法照 DSH 官方 `/api` 的信任栅栏（`dsh-client-connection/src/api-request-trust.ts`）：
  - Host 必须是本机回环（`127/8`、`::1`、`localhost`）或本实例自己的监听地址 —— 挡住 DNS rebinding；
  - `Sec-Fetch-Site: cross-site` 一律 403；
  - 带了 Origin 就必须与 Host 同一个 authority（`null` 这类不透明来源同样拒）。
- 直接后果：浏览器里随手打开的任何网页都调不动这些路由。代价：把 DSH 放在反向代理后面用域名访问时，这些路由会被拒、页面上不响（桌面版与直连端口不受影响）。
- 进程内 `webServer.readResource` 的读取（带 peer，不过 HTTP）直接放行。

### Added
- `test/guard.test.mjs`：13 条访问检查用例（把插件装到假 root 上、用合成 Request 打真实路由），`npm test` 即跑。
- `CHANGELOG.md`（这份）。

### Changed
- 无行为变更：音效选择、抽签权重、输入法组字期间静默、原生播放在正常页面里与 0.1.0 完全一致。

## [0.1.0] - 2026-11-10

### Added
- 首版：每轮 agent 回合结束（`turn/end`）随机播一段奶蛙音效；`naiwa-main.mp3` 在抽签池里占两票。
- 浏览器控制台接口 `__dshNaiwa`（play / random / list / test / state / setEnabled / stopAll）。
- 桌面版走 `webserver/index-inject` 的结构化注入行，网页版同样生效。

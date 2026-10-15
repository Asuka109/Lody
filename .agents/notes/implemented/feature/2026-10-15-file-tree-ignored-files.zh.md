# 在 Files 树中按需显示被忽略的文件

Status: implemented
Translation: current

[English](2026-10-15-file-tree-ignored-files.md)

## 摘要

会话 Files 树来自共享的 Code Collab 文件索引，扫描时会丢弃被 Git 忽略的路径，所以
`node_modules`、构建产物和 `.env` 对所有查看者都不可见。现在 Files 面板里有一个眼睛开关
（默认隐藏，即原有行为），打开它的查看者会在自己的树上看到这些名字。数据通过新的按查看者读取的
Machine RPC `code-collab/list-ignored` 获取，本地走 IPC，远端走加密 Streams。结果不写入共享索引，
也不进 owner state，所以 `.env` 这类名字只会到达这一位查看者，搜索、快速打开、`@` 提及和
All Changes 都不受影响。代价是时效：叠加数据在索引 revision、切换开关和重新展开时刷新，
只改动被忽略文件时不会刷新。

## 决策

- **CLI。** `CodeCollabV2Service.listIgnored` 对根目录运行
  `git ls-files --others --ignored --exclude-standard --directory`，整体被忽略的目录折叠为一个
  lazy 行；对被忽略的目录列出文件系统直接子项（只读名字，只隐藏 `.git`）。这些路径没有索引行担保，
  所以对真实路径做包含性检查。它不碰 owner state、Flock 和 watch 所有权，单次最多 5,000 条
  （`truncated`），错误 message 不含路径，因为 message 是明文传输。
- **协议。** `codeCollabIgnoredEntries: 1`。facade 在任何 I/O 之前检查该能力，旧 daemon 会立即失败，
  而不是等被丢弃的请求超时。
- **渲染层。** 隐藏时不发请求。显示时根目录 listing 在挂载和 provider 变化（索引 revision）时重新加载，
  被忽略目录在展开时加载。每个目录以最新请求为准，结果按 `viewStateKey` 存在内存里。
  `mergeIgnoredFileTreeEntries` 让索引路径优先、补齐缺失父目录；某目录的 listing 只有在更早的
  listing 把它加成被忽略的 lazy 目录后才采用，从而丢弃过期数据。被忽略的 lazy 目录走叠加加载，
  不走 `initializeDirectory`。
- **控件。** 用带 `aria-pressed` 的 ghost 图标 `Button`，与面板头部图标一致，不用 `Toggle`：
  隐藏是默认状态，Toggle 按下态的高亮会让静止状态成为面板里最亮的图标。状态由 Eye / EyeOff 表达。

## 备选方案

- **把被忽略的名字写进共享索引。** 未采用：所有成员和副本都会在 Flock 的 180 天生命周期内保留
  `.env` 这类名字，`node_modules` 会耗尽扫描预算，搜索和提及也会对所有人改变。
- **在 Electron 里读本地文件系统。** 未采用：只能服务桌面端所在机器，而需求是跨设备；
  Machine RPC 已经同时路由本地和远端。

## 已知局限

- 只改动被忽略文件时不会产生索引 revision，叠加数据要等下一个 revision、切换开关或重新展开时更新。
- pnpm 顶层 `node_modules` 的 symlink 显示为 skipped，无法展开。
- 非 Git 工作区不会显示额外内容。搜索、快速打开和 `@` 提及仍只用索引。移动端浏览器和
  `AutoFileTreeView` 不在本次范围内。
- 不支持该能力的机器会显示“无法加载未被托管的文件。”

## 验证

测试覆盖 CLI listing、两个响应 union、客户端与服务端的 Streams 加解密、facade 能力判断、合并函数，
以及树的开关、展开、缓存恢复和再次隐藏。远端 Streams 路径没有在只支持本地的 OSS 桌面端里端到端验证，
只由上述客户端和服务端测试覆盖。

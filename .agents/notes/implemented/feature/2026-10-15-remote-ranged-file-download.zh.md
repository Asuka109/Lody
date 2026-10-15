# 远程分块下载文件

Status: implemented
Translation: current

[English](2026-10-15-remote-ranged-file-download.md)

## 摘要

远程查看端此前无法获取远程预览因过大而拒绝的会话文件：“文件过大，无法预览”卡片只提供
“复制文件路径”，而菜单里的下载走的是同一个单次、有上限的预览响应，对这些文件必然失败。
现在新增 `file/read-range` Machine RPC 方法，通过 `fileReadRange` 能力协商，每次请求在与
远程预览相同的授权下返回最多 4 MiB 的一段。客户端把最多 256 MiB 的文件按同一版本拼接还原。
卡片、文件菜单和助手 Markdown 文件链接菜单都提供带进度、可取消的“下载文件”。
不支持该能力的机器只在文件菜单中保留原来的有上限下载。两项预算沿用已验证的预览响应大小，
尚未对托管网关实测。

## 问题与证据

File Preview v3 以一次响应返回内容，受 `FILE_PREVIEW_V3_LIMITS`（文本 10 MiB、二进制 5 MiB、
gzip 1 MiB）约束；远程文件超出时直接拒绝而不截断。`use-session-file-actions.ts` 中的远程下载
走同一个 `openFile` 调用，代码注释也写明了这个上限：错误卡片所展示的每个文件都会报
`sessions.fileActions.downloadTooLarge`。因此，直接在卡片上加下载按钮，点击必然失败。
[文件界面说明](../../../docs/sessions-file-surfaces.md)也已写明：突破上限需要一个经协议能力
协商的分段 Machine RPC 方法，而不是客户端重试。

## 决策

- **协议。** `file/read-range` 与 `file/preview` 并列，位于 `code-collab/` 之外，使用同一个
  owner 会话加密信封和同样的 owner 校验（`isOwnerScopedEncryptedRpcMethod`）。请求携带
  `offset`、`length`，从第二段起再带上 `revision`。Schema 与预算位于
  `packages/shared/src/file-read-range.ts`；能力版本即线上协议版本，声明方与检查方不会分叉。
- **机器端。** `FilePreviewService.readFileRange` 对每一段都按远程预览的规则解析和授权
  （同一个工作区解析器、同一套路径策略，绝不使用本地任意路径模式），路径被收回后无法继续读取。
  版本是设备号、inode、大小和纳秒级 mtime 的哈希；读取前后版本不一致或读取不足都返回
  `file_changed`。不会返回不完整或跨版本的字节，也不会激活 Code Collab。
- **客户端。** facade 只把该方法发给声明了此能力、且走云端平面的机器，同机 Electron 的路径
  不会进入 Streams 平面。`lib/session-file-range-download.ts` 同时只发一个分段请求，拒绝版本、
  偏移或大小不一致的分段；末尾之前的空分段也会被拒绝，否则会无限循环。hook 显示带“取消”的进度
  提示，只保存完整的文件。卡片和 Markdown 链接菜单上的“下载”只走这条通道，因为预览读取的
  回退方案对这些文件必然失败。原生移动端保留原有的有上限分享导出。
- **文案。** 卡片上“下载文件”作为主操作排在第一项，使用凸起的 `secondary` 样式，“复制文件路径”
  退为 `ghost`，与本机“打开”和原生“分享”的层级一致。Markdown 链接菜单改用
  与卡片相同的“复制文件路径”，删除了单独的 `sessions.fileActions.copyPath`（“复制路径”）键。
  这扩展了 [Markdown 文件链接菜单决策](2026-09-17-markdown-file-link-context-menu.zh.md) 中远程
  “只有复制路径”的菜单，但不改变其本地/远程能力范围的划分。

## 备选方案

- **只加按钮，复用现有下载。** 否决：对卡片展示的文件必然失败。
- **提高预览预算。** 否决：单次 Machine RPC 响应受网关上限约束，而本仓库无法断言这个上限；
  服务端对非 404 的 4xx 追加失败不会重试。
- **机器端在一次请求中推送多个进度信封**（类似 `machine/acp-binary-progress`）。未采用：
  由客户端逐段拉取，每次请求仍是一个有上限的响应，机器端在分段之间无需保存状态，
  取消也只需停止继续请求。
- **并行分段。** 暂缓：每段都会占用机器有限的 RPC 并发槽位，顺序传输已足以覆盖 256 MiB 上限。

## 局限

- 客户端在保存前把整个文件保存在内存中（Blob 分段），所以两端都设置了 256 MiB 上限。
- 任一分段失败会导致整个下载失败，没有逐段重试。
- 4 MiB 与 256 MiB 预算沿用已验证的 5 MiB 二进制预览响应，没有对托管 Streams 网关实测；
  [Spec](../../../../specs/local-file-link-actions.zh.md) 将其列为待评审问题。
- 机器需要升级 CLI 之后，卡片和 Markdown 菜单才会提供“下载”。

## 验证

已在安装完整依赖的环境中执行：CLI 服务测试（分段拼接与截断、`file_changed`、`too_large`、
`path_not_allowed`、空文件与 `invalid_range`）；Machine RPC 服务端测试（加密信封、owner
不匹配时拒绝）；shared 能力测试；以及组件测试，覆盖 hook（分段下载、版本变化失败、取消、
Electron 本机保护和菜单内容）、分段拼接器、facade 保护和通知卡片按钮。`@lody/shared`、
`@lody/loro-streams-rpc`、CLI 与 `@lody/components` 的类型检查均通过。尚未对真实机器和托管
网关做端到端传输测试，也未手动验证界面。

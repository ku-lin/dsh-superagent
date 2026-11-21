# dsh-superagent

**版本 1.2.6-sync.1** · [English](README.md) · **中文** · [更新日志](CHANGELOG.md) · [MIT](LICENSE) · [贡献指南](CONTRIBUTING.md)

> **仅供参照的研究原型，不是 DeepSeek 的官方产品。** 这份代码出自团队日常开发工作，其中大量工程由编码智能体完成。请把它当作研究代码，而不是可直接上生产的软件：它可能仍有缺陷，代码风格与工程实践也可能不一致。用于你自己的环境前，请先审阅并改造。
>
> 我们为公开发布做过适配，因此它与我们的内部版本、以及《Exploring Super-agent Design: Towards a More Autonomous Agent System》一文描述的实现在细节上并不相同。文中讨论的部分设计属于后续方向，本原型并未实现。

`dsh-superagent` 面向**一个 GitHub 仓库**提供主动式编码智能体，以 [DeepSeek Harness](https://www.deepseek.com/en/harness/)（下称 DSH）的 bundle（插件）形式打包。它监听 GitHub，可选监听飞书；当名单内的人提出请求时，它开出一张工作项，在**自己的会话与目录**里完成，并回到原对话答复，例如提交一个 PR。Web 面板显示哪些事需要人来做。

它同时也是一种与智能体协作的方式：**尽量少占用人的注意力，尽量多交付价值。** 一个能替整个团队行动的智能体，也能浪费整个团队的注意力，所以它只在被要求时、或团队写下的规则允许时才行动；只在有人必须行动、或结果确实可用时才开口。[docs/000-philosophy.md](docs/000-philosophy.md) 讲这条原则以及对操作者的要求。

## 它解决什么问题

单个聊天会话撑不起一个团队：请求从多个地方来，每个人又都希望在自己提问的地方得到答复；而一个常驻的智能体要么卡在一件事上，要么去做没人要的事。`dsh-superagent` 把它拆成三个落盘的决定：

1. **请求从哪里来** —— *Source*（GitHub 通知与 @ 提及，或飞书群）把消息变成 *Trigger*。
2. **谁可以提要求** —— *Policy* 决定某个 Trigger 是否变成 *Ticket*。名单为空时，任何请求都不会成为工作。
3. **之后怎么执行** —— 每张 Ticket 在自己的 DSH 会话里运行，结果投递回它来自的那个对话。

## 工作机制（Router / 编排）

bundle 定义了两个 DSH 智能体 preset，构成 Router 与 Worker 的分工：

- **`dsh-superagent-router`** —— 主 Session，被裁剪成只做路由：没有 shell、没有沙箱、没有后台任务工具，文件系统**只读**（`write`、`edit` 关闭），保留技能与上下文压缩。它只派单，不亲自执行命令。同样不提供：子智能体、文件搜索、web、待办列表、向人提问、展示、规划模式、插件管理、定时任务、目标与工作流。
- **`dsh-superagent-worker`** —— 执行器 Session，同时就是一个**普通的 DSH 会话**：它出现在你打开的那个 Workspace 里，标题为 `worker-<id> · <工单标题>`，工作目录是该 Workspace 的目录，可以像任何一个会话那样被点开、对话。它具备干活所需工具：可写文件系统、shell、文件搜索、待办、无抓取的 web 搜索。

Worker **不派生**子智能体。它通过工单自带的 `orchestrator_*` 工具汇报，Router 用 `orchestrator_worker_list` / `orchestrator_worker_message` 与它对话。消息投递后调用立即返回，Worker 的答复在该轮结束时作为**普通消息**回流到 Router 自己的会话里，因此 Router 不会挂在定时器上等待。

Worker 里前台命令或任务等待超过 **5 秒** 会转入后台任务，长命令不会挡住下一个候选。两个 preset 都无法从 preset 选择器里隐藏（DSH 没有这个设置），所以它们的名称与描述写明面向谁。**不要为个人会话选择它们。** 见 [cordis.patch.yml](cordis.patch.yml)、[docs/003-execution.md](docs/003-execution.md)、[docs/007-architecture.md](docs/007-architecture.md)。

面板默认打开 **Router** 页：与主 Session 的对话、可被工单借用的 Worker 会话、以及只读的插件索引/搜索。其余标签页是工作视图。面板与宿主通过 `/orchestrator/api/` 下的本地 HTTP API 通信，见 [docs/006-deployment.md](docs/006-deployment.md#management-api)。

## 环境要求

- **Node.js** `^22.19.0 || >=24.0.0`（见 `engines.node`）
- **pnpm**（`packageManager` 字段锁定版本，corepack 会遵守）
- **DeepSeek Harness** 落在 `engines.dsh` 范围内 —— 当前为 `^0.2.1-alpha.2`。因为这些是预发布版本，DSH 自身的兼容门很严格：只有 DSH `0.2.1-*` 预发布版本会被接受。
- 服务宿主上需要 **git** 2.32+、**Python** 3.8+、**tmux**、**GitHub CLI** 2.48+（`gh`）
- 服务所用 DSH profile 里已配置好的模型提供方
- **github.com** 上的一个仓库（不支持 GitHub Enterprise Server）
- 可选，飞书：`lark-cli`（按 1.0.90 测试）与一个带机器人能力的飞书/Lark 应用

## 安装

> **未发布到 npm。** 本仓库以源码方式分发，`npm install dsh-superagent` 不会生效。下面是本地构建并链入一个专用 DSH profile 的步骤。

```sh
npm install -g @deepseek-ai/dsh@0.2.1-rc.3
git clone https://github.com/ku-lin/dsh-superagent.git
cd dsh-superagent
pnpm install && pnpm build

# 创建专用 profile（仅新安装需要）。
dsh superagent --from-default-profile web --dump-config > /dev/null
dsh plugin --profile superagent add "link:$PWD"

# 机器配置：替换其中每一个 <placeholder>。
cp examples/profile.cordis.patch.yml ~/.dsh/profiles/superagent/cordis.patch.yml

scripts/dsh-superagent start
```

`scripts/dsh-superagent start` 在 tmux 会话 `dsh-superagent` 里运行 `dsh --profile superagent`，最多等一分钟直到运行时就绪、或报告还缺什么设置。打开日志里打印的 URL，在侧边栏选择 **Superagent** 即可看到面板。

请把这个 profile 与你日常工作的 profile 分开：插件会修改进程级 `PATH` 与 git 配置，它的进程也需要独立重启与升级。

**设置流程按设计是交互式的。** 完整路径（账号、智能体的 GitHub CLI 包装器、飞书机器人、各项设置、验证）步骤较多，所以由智能体陪你走。对你的编码智能体说：

> 读本仓库的 SETUP.md，和我一起把 dsh-superagent 配好。

## 最小示例

等设置不再缺项（`scripts/dsh-superagent status` 退出码 0）后，用名单内的 GitHub 账号：

1. 开一个 Issue，或发表一条评论，内容含 `@<智能体登录名> <请求>`。
2. 在一个轮询周期内（默认一分钟），面板 **概览** 出现一张 Ticket。
3. 智能体在线程里确认，在自己的会话与目录里干活，并在那里交付 —— 例如一个 PR。

在 GitHub 上，*编辑*已有 Issue 正文新增的 @ 提及不会被收到；请另发一条评论。

## 配置

两层，且刻意分开。

**机器配置** —— `~/.dsh/profiles/<profile>/cordis.patch.yml`，从 [examples/profile.cordis.patch.yml](examples/profile.cordis.patch.yml) 复制。修改后需重启。

| 键 | 必需 | 含义 |
| --- | --- | --- |
| `stateDir` | 是 | 绝对路径：数据库、锁、`worker-bin` 下的命令 shim、智能体的 git 配置，以及默认放在 `work` 下的工单目录。升级前请备份。 |
| `promptMaxChars` | 否 | 保存的提示词配置的最大字符数。 |
| `admissionContextMaxPages` | 否 | 一次评估读取多少页线程。 |
| `admissionContextTimeoutMs` | 否 | 该次评估最多耗时。 |

`stateDir` 接受宿主认识的任意绝对形式（`/srv/dsh-superagent`、`C:\dsh\superagent`、`C:/dsh/superagent`、`\\server\share\superagent`）；相对路径或 `~/dir` 在启动时会被拒绝。首次启动后，机器限制可在 **设置 → 部署** 里改；`stateDir` 不行。

**应用设置** —— 在面板里改，或通过本地 API（`PUT settings/<block>`）。多数无需重启。

| 块 | 内容 |
| --- | --- |
| `source:github` | `repository`（`owner/name`）、`cli`，以及观察开关 `observeIssues`、`observePulls`、`observeComments`、`observeCi`（默认全关） |
| `source:feishu` | `cli`、`chats`（`chatId`、`name`、`listen` = `mentions` 或 `all`）、`directMessages`、`otherChats` |
| `policy` | `rules`，以及每个 Source 的 `allowed` 名单、`bots`、按群/按渠道的 `admission` 默认值 |
| `executor` | `model`、`maxWorkers`、`workspace`、`directory`、`prepare`、`blockedCommands` |
| `eval` | `mode`、`timeoutSeconds`、`model` |
| prompts | 团队段落：GitHub 披露行、评审机器人、提交作者、自动合并条件 |

完整 API、各块内容与排错表见 [docs/006-deployment.md](docs/006-deployment.md)。

## 权限与安全

在你在意的机器上运行之前，请先读这一段。

- **对操作者没有任何隔离。** 两个 preset 都以 `danger-full-access`、以操作者的操作系统账号运行，读取已订阅线程里的消息，Worker 可以按路径执行程序、读取操作者的主目录。账号包装器只决定智能体用哪套凭据，**并不沙箱化**进程。需要隔离就另开一个只放智能体凭据的操作系统账号。（[docs/006-deployment.md](docs/006-deployment.md)）
- **必须有一个专属 GitHub 账号，这不是"建议"。** 智能体以该账号评论、推送、开 PR。GitHub App 不能充当智能体，因为智能体读的是该账号的通知。请把它指向一个只用该账号凭据的 CLI 包装器。
- **凭据处理。** 设置会在 `<stateDir>/worker-bin` 写入命令 shim（置于 `PATH` 最前），并在 `<stateDir>/worker-gitconfig` 写入一份 git 配置，**替换**操作者的全局与系统 git 配置。它会移除名字含 `KEY`、`PASSWORD`、`SECRET`、`TOKEN` 的环境变量，移除 `GH_TOKEN`/`GITHUB_TOKEN`，并让 git 永不提示输入。这两个目录里出现不是它写的文件，设置会中止。
- **仅本地 HTTP。** API 只绑回环地址（`127.0.0.1`/`localhost`），并要求 `x-orchestrator-request: 1` 头；带外部 `Origin` 的请求返回 403。除此之外没有鉴权 —— 请把任何本机进程都视为可驱动它。
- **智能体会被"说动"到什么程度。** Policy 是聊天消息与"能执行命令的会话"之间唯一的闸门。名单请从短开始。

## 兼容性

| | |
| --- | --- |
| DeepSeek Harness | `engines.dsh: ^0.2.1-alpha.2` —— 已发布代码在 **DSH 0.2.1-rc.2** 上验证 |
| Node.js | `^22.19.0 \|\| >=24.0.0`；CI 覆盖 22.19 与 24 |
| GitHub | 仅 github.com；不支持 GitHub Enterprise Server |
| 飞书 | 可选；按部署指南使用 `lark-cli` 1.0.90 |
| 服务宿主系统 | `scripts/dsh-superagent` 需 **POSIX**（用了 `fcntl`、`ps`、tmux）—— 见已知限制 |

因为 `engines.dsh` 指的是预发布版本，DSH 的兼容门会拒绝更高的次版本线。被新版本迁移过的数据库无法被旧版本打开：升级前请备份 `<stateDir>/orchestrator.sqlite`。

## 已知限制

诚实清单 —— 其中几项正是"能跑"与"被支持"之间的差别。

- **研究原型。** 未达生产标准，不是 DeepSeek 官方产品，除作者外无人审阅。请预期缺陷。
- **Worker 的 shell 从它所在 Workspace 的根目录开始。** Worker 会话只声明了 Workspace，所以 DSH 把 `workspace.path` 作为工作目录：命令运行在工单所在目录的根部，而不是工单自己的目录里。工单目录仍然存放执行器准备好的内容（worktree、日志、证据）。
- **Worker 以 `danger-full-access` 运行：没有任何文件系统围栏。** 该权限预设把整台机器交给 Worker 的工具，和人的会话一样；没有任何东西阻止它读写 Workspace 之外。请把 harness 跑在你愿意暴露的机器与账号上。
- **同一 Workspace 同时只跑一个 Worker。** 指向已有运行中 Worker 的 Workspace 的工单会等它（每 5 秒复查一次）；不同 Workspace 的工单并行，最多 `executor.maxWorkers` 个。
- **`scripts/dsh-superagent` 仅 POSIX。** 它导入 `fcntl` 并调用 `ps`/`tmux`。Windows 上请在 WSL 里用，或自己启动 profile、跳过脚本的日志与控制处理。
- **未发布到 npm。** 从源码安装且有构建步骤；注册表上还没有版本化产物。
- **peer 版本被钉死。** `@deepseek-ai/*` 的 peer 依赖钉在 `0.2.1-alpha.2` 线（`@deepseek-ai/cordis` 钉 `4.0.5-alpha.1`，`@deepseek-ai/schemastery` 钉 `3.18.5-alpha.1`）。更新的 DSH 可能拒绝这个 bundle。
- **每次安装一个仓库。** GitHub Source 只取一个 `owner/name`。
- **测试套件不覆盖端到端流程。** 测试用夹具覆盖单元与面板；GitHub 与飞书的往返需要真账号、真机器人与真仓库，CI 不验证。
- **CI 无法验证 DSH 运行时行为。** 它只做类型检查、跑单测、检查包内容；CI 里不启动 DSH。
- **套件里有依赖轮询的测试。** 若干 source 测试用 `waitFor` 等待真实子进程，因此 CI 会在负载高的机器上重试一次作为保险。
- **`npm pack`/`npm publish` 前必须先 `pnpm build`。** `lib/` 是构建产物，不提交。
- **界面只有中英两种**（`locale/en.json`、`locale/zh.json`）。

## 文档

按顺序读编号文档；每篇只依赖前面那些。

- [000 理念](docs/000-philosophy.md)
- [001 领域模型](docs/001-domain.md)
- [002 授权](docs/002-authorization.md)
- [003 执行](docs/003-execution.md)
- [004 提示词](docs/004-prompts.md)
- [005 面板](docs/005-panel.md)
- [006 部署](docs/006-deployment.md) —— 手工设置、配置、升级、排错
- [007 架构](docs/007-architecture.md)
- [008 实践手册](docs/008-cookbook.md) —— 新增一个 Source

## 开发

```sh
pnpm install
pnpm typecheck   # tsc --noEmit
pnpm test        # vitest run
pnpm build       # tsdown -> lib/
pnpm check       # 以上三项
```

`pnpm build` 产出 `lib/`，`package.json` 通过 `files` 发布它；用 `npm pack --dry-run` 检查结果。见 [CONTRIBUTING.md](CONTRIBUTING.md)。

## 来源与改动

本仓库把 MIT 授权、公开发布于 [`deepseek-ai/dsh-superagent-prototype`](https://github.com/deepseek-ai/dsh-superagent-prototype) 的研究原型重新打包为独立插件仓库。代码是他们的；[LICENSE](LICENSE) 里的版权声明未改。

相对该上游快照，此处所做的改动：

- 为独立发布整理打包元数据：移除 `private`；增加 `repository`、`bugs`、`homepage`、`keywords`、`publishConfig`；`files` 扩展了 `docs`、`SETUP.md`、`examples` 与 `CHANGELOG.md`；增加 `prepublishOnly` 构建钩子。
- 增加 `CHANGELOG.md`、`CONTRIBUTING.md`、`.gitattributes`（所有文本文件用 LF）、GitHub Actions 工作流（类型检查 + 测试 + `npm pack --dry-run`），以及更完整的 `.gitignore`。
- 本 README 重写过，明确写出安装步骤、配置、权限与限制；代码本身未因此改动。

通用的修复应回上游；与打包相关的留在这里。

## 许可证

[MIT](LICENSE) © DeepSeek Harness Team。

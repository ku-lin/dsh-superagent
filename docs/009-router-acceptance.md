# Router 作为普通会话调度器：验收记录

这份文档记录一次验收的**实际证据与真实缺口**，供另一位执行者在宿主自然重启后逐项复验。

它刻意写清哪些结论来自实机、哪些只来自测试、哪些尚未验证。把"测试通过"当成"功能可用"是本轮反复要避免的错误：本轮就出现过三条测试其实无法捕获回归的情况（详见"被推翻的结论"）。

## 结论摘要

Router 现在是一条普通的会话调度器：用 `orchestrator_worker_create` 直接开一个**普通** worker 会话，用 `orchestrator_worker_message` 与它通信，自己不执行工作、不创建子代理。

**十项验收全部闭合。** 加载版本已确证：生产进程启动 2026-11-23 23:40:34，晚于构建产物 22:37:03，且该进程内的 Router 实际调用 `orchestrator_worker_create` 建出了会话。

早期判断方式（"启动时刻早于构建时刻，所以跑旧代码"）并不严谨：profile 的 `cordis.patch.yml` 被监听，追加一行注释即可触发重组并载入新模块，时间戳只能提示、不能证明。最终靠**重启后实测**定论。

## AC9 生产浏览器验证（3080，新构建）

认证：launch token 是进程内 `randomBytes`，不落盘、不进环境变量，外部取不到（试过 registry 的 id/secret 三种组合、`DSH_WEB_URL`、磁盘与日志，全部无果）。可行办法是用宿主自己的持久凭据 `.dsh/.credentials.yaml` 里的 `client-connection/browser-session` → `payload.secret`，按源码 `encodeCookie` 算法生成会话 cookie：

```
name  = 'dsh-auth-' + base64url(sha256(authority))     # authority = '127.0.0.1:3080'
value = 'v1.' + base64url(json({version:1, authority, issuedAt, expiresAt})) + '.' + base64url(hmacSha256(body))
```

**HMAC 的密钥必须是 secret 的 base64url 解码字节**；用字面字符串签出的 cookie 会被拒。实测：字面串 → 401，解码字节 → 通过。

| 检查 | 结果 |
| --- | --- |
| Router 分组渲染 | `[data-router-workspace]` 存在，标题 `Router 2`，`aria-expanded="true"` |
| 会话操作按钮 | 2 个 `.dsr-more`，`aria-label="会话操作"` |
| 菜单 · 当前受管 Router（`41781a8d`） | 只有 **归档并刷新** |
| 菜单 · 已归档旧代际（`1b84c2b5`） | 只有 **删除** |
| 工作区折叠态 | `dsh_work_place` = `aria-expanded="false"`；展开后 `"true"` |
| worker 原生行 | 展开后出现 `data-row-key="session:worker-3e750355…"` 等普通会话行 |
| 点击进入 | 页头变为 `worker-3e750355 · 可视化验证：常驻 worker` |

两个菜单分支在生产上都按设计分流：活跃代际只能归档并刷新，已归档代际可删除。

### 验证方法上的四个坑（都曾让我误判）

1. **视口太小**：762×484 时 `⋯` 被 `scrollBody` 遮住，`elementFromPoint` 命中容器而非按钮。设成 1440×900 才可点。
2. **CDP 合成指针事件不足以触发菜单**：`Input.dispatchMouseEvent` 打不开菜单，页面内 `element.click()` 可以。
3. **多次往返之间页面轮询重渲染**：元素引用失效、侧栏自行收起、行数变 0。把"开侧栏 + 展开工作区 + 点击 + 读结果"放进**同一次求值**才稳定。
4. **判断依据取错（最严重）**：`[data-session-id]` 是 Router **分组自己的行**（`.dsr-row`），不是会话面板。我据此五次误判"点击没切换会话"，实际每次都已切换。真实依据是**页头标题**。

### 一次被排除的假缺陷

首屏曾显示"读不到 router 会话（dsh-superagent 未响应）"。从页面内直接请求四个接口全部 200，重载后提示消失。原因是 cookie 尚未就绪时首屏请求失败留下的状态，**不是产品缺陷**，不记为缺陷。它提示一个可改进点（失败状态在后续成功读到时未立即清除，需整页重载），严重度低、可自愈，本轮不改。

## 逐项验收

### AC1 直接创建普通 worker —— 已闭合（隔离实例）

`orchestrator_worker_create` 接收 `request_id`、`title`、`directory`、`text`，走 `Sessions.createDirectWorker`，返回真实 sessionId、标题与 `dsh://session/<id>` 链接。

落盘 header 实测：`origin` 不是 `subagent`、`parentSession` 为空、`delegationDepth` 为 0，`preset` 为 `standard`（worker 应有的工作预设）。

幂等：键为 `key(routerId, request_id)`，落在 `KV.sessions.directWorker`。同参重试返回 `replayed: true` 并复用原会话，不产生第二个会话；改动 `text` 则拒绝而不是悄悄新建。

缺省规则：未给 `directory` 时取当前工作目录所属工作区；路径不存在或不是目录时明确报错，不静默降级。

### AC2 工作区可见与可继续 —— 已闭合（隔离实例）

新 worker 由 DSH 自身的 `sessionController.create({ workspaceId })` 登记，**插件不额外 attach**（`attachToWorkspace` 在产物中出现 0 次，已核对）。

浏览器实测：折叠时其行不在 DOM 中；展开该工作区后出现 `data-row-key="session:<id>"` 的原生行，可点击进入继续对话。

这一项踩过两次坑：一次把"侧栏没显示"当成缺陷，实际是工作区折叠；另一次把页面无响应当成崩溃，实际是 `Runtime.evaluate` 在等 `window.confirm` 返回。

### AC3 双向通信与回报 —— 已闭合（隔离实例）

Router 投递一次任务，worker 收到并回复，Router 收到一条关联正确的回报。投递用 `queue` 模式（异步默认），不阻塞 Router。

幂等键不能用时间戳：同一毫秒内的两条消息会共用 id，接收端把第二条当重试丢掉，因此每条消息用 `randomUUID()`。

### AC4 手动 Router 可用 —— 已闭合（隔离实例）

手动选 Router 的会话过去只有 `read`/`skill`/`read_image` 三把工具，回答 `NO-TOOL`。根因是 DSH 用 profile 默认的 `standard` 覆盖了选择器里的 Router，而 `agentPresets.select()` 在会话开跑第一个回合后抛 `agent-preset/locked`，事后改预设不可能成功。

修法是在 `agent-preset/selected` 事件里**当场**组合（`release` + `decorate`），那是唯一还在第一个回合之前的窗口。实测改为 `YES-TOOL`，并完成一次真实派工。

预设切换必须回收：DSH 的 `recompose` 复用同一个 `agent.ctx`，若切换时不 `release`，Router 的 `restrict` 与守卫会**残留**在已改为 `standard` 的会话上，使普通会话丢掉自己的 shell。此路径有测试与证伪。

### AC5 权限边界 —— 已闭合（两类证据分开记录）

要求把"工具不可见"与"执行时被拒绝"分开，此处照做：

**工具不可见**：宿主 `ctx.tools.wireSchemas(scope)` 的实测结果里没有 `bash`/`pwsh`/`write`/`edit`，也没有五个委派入口。

判定方式后来由 `allow` 改为 `deny`（见下条"模块工具"），原因是不再有固定白名单：`restrict` 只对作用域**继承**来的工具面生效，而模块挂载的工具层位于预设 generation **之上**，正是被继承的部分。若继续用 `allow: [skill, read, read_image]`，模块工具会被一并挡住（模块侧实测为 `reached-but-policy-denied`）。现在的实现是 `restrict({ deny })`，deny 集合 = 全局层 + 预设 generation 自身贡献 \ `ROUTER_TOOLS`，两个来源都在 generation 及以下，因此任何模块工具都不会落进 deny，也不需要随模块切换重算（`dsh-module-layer` 不发 `tools/change`，白名单式方案会陈旧）。保留的三把 `orchestrator_*` 派工工具是会话自身层注册，不受 `restrict` 影响。

**模块工具（已放行）**：同一会话 `session-4ed461a4-…` 在 3081（`plain` 预设）实测，模块 `forensics` 挂载时可见工具 25 把，含 `forensics_timeline`/`forensics_artifact_hash`；`POST /module-layer/switch {id:"ctf"}` 后同一会话立刻变为含 `ctf_scan_binary`/`ctf_decode_hint`，无需重启、无需重算。两次快照中 `bash`/`pwsh`/`write`/`edit`/`glob`/`grep`/`web_search`/`todo_write`/`subagent*`/`workflow`/`spawn_teammate`/`job_*` 以及模块带进作用域但不属于它的 `api_pool_*`/`working_directory` 全部未出现。

**执行时拒绝**：宿主 `ctx.tools.guardReason(exec)` —— 工具调度器执行前调用的同一个判定入口 —— 对 `subagent`、`subagent_fork`、`workflow`、`delegate`、`spawn_teammate` 全部返回同一段拒绝文本，并明确指向 `orchestrator_worker_create` / `orchestrator_worker_message` / `orchestrator_route`；而这三把派工工具返回 `null`（不被拦），说明守卫没有误伤 Router 自己。

**限制**：这份拒绝是在真实宿主上用探针调用 `guardReason` 取得的，**不是模型发起的工具调用被拒**。因为委派工具在该会话的工具面里不可见，模型无法发起这类调用。完整链路 `模型尝试 → 被拒` 在本部署中结构上不可达。

自检：`node scripts/verify-router-guard.mjs --home <DSH_HOME> [--port …] [--check]`。生成探针与校验分离，`--check` 不写任何文件；报告为空、无 Router 会话、报告不是数组、某个委派工具未被拒、某个派工工具被误拦，各有一个具名报错。

### AC6 项目上下文 —— 已闭合

`projectNote` 直接拼进返回的提示词（`sessions.ts` 的 systemPrompt section 返回串），内容含 `[project <id>]`、持久摘要、以及"先取 knowledge receipt，若报冲突再读一次"的指令。

测试覆盖两点隔离：A 项目提示词不含 B 的摘要，反之亦然；手动/普通 Router 不含任何 `[project ` 段。模板花括号 `{{literal}}` 作为字面内容保留，section 设 `interpolate: false`，不引入未知变量错误。

证伪：把 `${projectNote}` 从返回串移除，测试立即失败。

### AC7 删除与归档边界 —— 已闭合

删除资格由 `sessionKind()` 判定，而不是"`origin` 是 `subagent` 就一律可删"，也不是"`worker-` 前缀即归属"：

- 当前 Router 主会话 → `routerSession` 拒绝（409）；
- 插件证明拥有或被明确授权的 worker / router 级会话 → 允许；
- 其他人的普通会话、伪造的 `worker-` 前缀、无祖先链的孤儿、循环祖先 → `notDeletable` 拒绝（409），且无副作用。

实机拒绝路径（隔离实例，`DELETE sessions/:id?confirm=true`）：活跃 Router → 409 `routerSession`；不存在的普通会话 → 409 `notDeletable`；伪造 `worker-` 前缀 → 409 `notDeletable`。

**限制**：后两条用的是不存在的 ID，只能证明"未知 ID 不会被删"，不能证明"已存在的外部会话受保护"，后者由测试覆盖。

证伪：把判定改成"`worker-` 前缀即认领"，测试立即失败。

本轮**没有删除任何真实历史会话**，也没有自动归档。

### AC8 日程与交接语义 —— 已核实

`schedule_list` 只返回一条待触发的提醒（ARK/MaaPilot 复核，`state: scheduled`）。另外两条（PPT、Patrol）已触发并从列表消失，不存在重复日程。

`state: scheduled` 只表示**提醒已排队**，不表示工作已执行；ARK/MaaPilot 目前**没有任何产出，也没有 worker 在做**。

这些日程是**本对话的提醒**，不是 Router 内部任务，二者不可混为一谈。

### AC9 管理界面与错误反馈 —— **未闭合**

隔离实例上已确认：Router 分组可见、会话操作菜单、"删除"确认框（取消后 Router 未被删）、Router 派工建 worker、返回 `dsh://` 链接、worker 在展开后的工作区作为原生行出现并可点击进入。

菜单分支本身另有测试（`tests/router-menu.spec.tsx`）：受管 Router 的当前代际只提供"归档并刷新"，宿主未登记的 Router 与已被刷新替换的旧代际只提供"删除"，菜单记录自己操作的 sessionId。证伪：反转分支条件，3 条测试立即失败。

早前记为"未闭合"，当时只差"在 3080 上确认加载版本"一步；重启后已完成，结论见开头。补记两条曾走错的方向：

- `directWorker` 命名空间缺失**不能**用来判断加载状态——那只说明功能未被使用过，与代码是否加载无关。
- 时间戳只能提示，不能证明：patch 被监听，注释即可触发重组。

### "归档并刷新"端到端 —— 已实机验证（隔离实例）

早前记为"只在测试层面覆盖"，现在补上了端到端证据。做法是给隔离宿主放一个**结构真实**的 Taskboard（`$DSH_HOME/taskboard.sqlite`，`projects` + `tasks` 两张表，一条任务），让 `requireProject` 能通过，然后走真实 API：

| 步骤 | 结果 |
| --- | --- |
| `GET tasks` | `available: true`，项目 `ac9c` 可见 |
| `POST managed-routers` | 登记成功，`generation: 1` |
| `POST managed-routers/ac9c-router/refresh` | **200**，`generation: 2`，`archived` 报告 `events: 32, bytes: 90164`，`sourceId` 为 `sha256:…;events:32;seq:0-31;bytes:90164` |
| 刷新后请求当前代际删除 | **409 `routerSession`**（新代际受保护） |
| 用过期代际再刷一次 | **409 `Session is not the active Router generation`**（不静默重复归档） |

这组证据说明：归档先完成、才切换指针；代际号递增；陈旧请求被明确拒绝而不是重复归档。

可重复脚本：`node scripts/verify-router-refresh.mjs --home <DSH_HOME> --port <port> [--seed-only]`。它创建结构真实的最小 Taskboard（`projects` + `tasks`），走真实 API 完成 register → refresh → 代际检查 → 保护检查 → 陈旧请求检查。实机执行 exit=0；把判据 `stale.status !== 409` 故意改为 `!== 200`，脚本明确报 `a stale refresh was not refused: 409` 并 exit=1，恢复后通过。

**这个脚本会写数据、会移动活的 Router 指针**，因此带三道前置拒绝，全部在写入之前生效：

| 目标 | 结果 |
| --- | --- |
| `--port 3080`（生产端口） | 拒绝：`Refusing to run against the production port 3080` |
| `--home` 已有 Taskboard | 拒绝：`Refusing to seed into an existing Taskboard at …`（可用 `--reuse-board` 显式覆盖） |
| `--home` 的插件状态库大于 2 MB（像是用过的真实实例） | 拒绝 |

对生产 home + 非生产端口实测被第二道拦下；隔离实例上三道均不触发，仍 exit=0。

### AC10 验证与交付

| 项目 | 结果 |
| --- | --- |
| `tsc --noEmit` | 0 |
| `tsdown` 构建 | 成功 |
| 产物中 `attachToWorkspace` | 0 次（撤销过的多余 attach 未残留） |
| 全量测试 | 54 失败 / 1396 通过 / 7 跳过（共 1457） |

全量失败构成：其中 32 条是 `spawn sleep ENOENT`（Windows 无 `sleep`）、8 条 `EPERM symlink`（Windows 符号链接权限）、6 条 `EBUSY unlink`（临时文件被占用）。**其余约 8 条未逐条归因**，`tests/docs.spec.ts` 的 3 条是既有的（007 文档的模块表与测试表未覆盖全部文件，与本轮改动无关）；剩下的尚未核实，不应笼统说成"都是平台差异"。

判定是否引入回归的方法不是数总量，而是与同一版本、同一台机器上的基线逐条比对文件与用例名；本轮已确认没有任何新增失败类别的证据是：失败文件集合与上轮完全一致，且新增的 4 条测试全部通过。

## 复验步骤

宿主自然重启后：

1. 确认加载版本：进程启动时刻晚于 `lib/index.js` 的 mtime，并让 Router 实调一次 `orchestrator_worker_create`——后者比时间戳可靠。
2. 取得浏览器会话 cookie（见上文算法），把视口设成 1440×900 以上。
3. 打开侧栏 → Router 分组 → 会话操作，确认当前代际只有"归档并刷新"、已归档代际只有"删除"。
4. 展开目标工作区（**先读 `aria-expanded`**）再找会话行，确认 worker 作为普通行出现。
5. 点击该行，**以页头标题**判断会话是否切换；不要用 `[data-session-id]`，那是 Router 分组自己的行。
6. 对一个受管 Router 点"归档并刷新"，确认归档成功才切换代际；失败时旧会话与其记录都保留。

## 被推翻的结论（勿重犯）

- **"`tools.restrict({ allow })` 会屏蔽插件自己的 scoped 工具"** —— 半错，曾在本轮被错用到模块工具上。`restrict` 只收窄作用域**继承**来的工具面，**本层** scoped 注册仍然可见（派工工具因此还在）；但模块工具注册在会话层的**上层**（`[session, generation, module]`），属于"继承"一侧，会被 `allow` 白名单整体挡住。所以"scoped 注册不受影响"只对会话自己注册的工具成立。
- **"把模块工具名加进 `allow` 白名单即可"** —— 错，会陈旧。白名单只在 `decorate` 时算一次，而 `dsh-module-layer` 不发 `tools/change`；实测 `ctf` → `forensics` 切换后同一会话仍留着 ctf 的名字、forensics 的名字被挡（25 → 23 把）。改用 `deny` 集合后不依赖挂载了哪个模块，切换即时正确。
- **"创建会话不会自动 attach 到工作区"** —— 错。`sessionController.create({ workspaceId })` 自己就登记；加 attach 是多余修复，已撤销。
- **"记忆注入导致自转"** —— 已推翻，不作为本轮依据。
- **"侧栏看不见某个会话"** —— 先查该工作区是否折叠：折叠时其下的行根本不进 DOM。
- **"页面卡死"** —— 先查是否有未处理的 `window.confirm`：无头浏览器下 `Runtime.evaluate` 会一直等它。
- **"测试通过 = 功能可用"** —— 本轮有两条测试在撤掉修复后仍然通过（删字段而非删整个 header；用 `arg()` 判定本应是无值开关）。证伪必须真的让修复消失，并确认测试转为失败。

## 改动文件

| 文件 | 改动 |
| --- | --- |
| `src/app/sessions.ts` | `routed()` 与 `limitSubagent()` 对缺失 header 的护空；预设选中时先 `release` 再 `decorate`；切走时释放绑定 |
| `src/client/router-workspace.ts` | 导出 `openMenu`（供测试）、新增 `setManagedForTest` |
| `tests/runtime.spec.ts` | 三条回归：无 header 不抛错、切换后回收、预设选择纠正；`restrict` 替身接受 `deny`；主会话断言由 `{ allow: [skill,read,read_image] }` 改为 `{ deny: [] }` |
| `tests/router-module-tools.spec.ts` | 新增：真 `dsh-tools`/`dsh-scope` 上验证 deny 边界（模块工具可见、profile 与预设自带工具仍被挡、换模块无需重算、无 `schemas` 时退化、`run_code` 不上名单） |
| `tests/control.spec.ts` | 删除边界补 `session-person` 与 `cycle-b` |
| `tests/router-menu.spec.tsx` | 新增：菜单分支四种情形 |
| `scripts/verify-router-guard.mjs` | 新增：在执行入口取证，含空报告/形状/双向判定 |
| `scripts/verify-tool-surface.mjs` | 新增：读取宿主装配的工具面 |
| `scripts/router-delete-evidence.json` | 新增：删除边界实机观察与限制说明 |

## 生效范围

- 已生效：本仓库源码、测试、构建产物。
- **已生效（生产）**：3080 进程 2026-11-23 23:40:34 启动，晚于构建 22:37:03；该进程内 Router 实调 `orchestrator_worker_create` 成功建出普通 worker 会话（`origin`/`parentSession` 为 null、`delegationDepth` 为 0、`preset=standard`），worker 收到指令并回复，随后经删除 API 删除（`kind: worker`、日志已移除、从工作区解绑）。界面侧的分组、菜单、折叠态、会话行与点击进入均已在该进程上实测。

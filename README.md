# dsh-openpencil-studio

独立的 DSH OpenPencil 工具适配器。官方包只提供代码和原生运行时依赖；Studio 不调用官方插件的 apply()，不注册其默认工具、生成控制器、系统提示词或参考技能。

本插件指导模型使用工具、管理文件和修复技术错误。页面结构、样式、内容、画板数量与尺寸由用户要求和模型判断决定，没有网站模板、固定批次数、预设商品集合、强制字体或配色。

## 复用与边界

- 固定依赖 @zseven-w/dsh-openpencil **0.1.0-rc.13**。启动时核对版本；本次实际原生运行时为 OpenPencil **0.8.5**，revision **442c48418697ae944db8bad5bad57f62ee57b1cc**。
- 内部模块适配：[official.ts](src/official.ts) 只加载官方 lib/editor-runtime.js 和 lib/editor-recovery.js，复用运行时定位及文档读取。文档恢复使用 Studio 自己的带版本检查的原生端点。
- 范围明确的源码复用：[vendor-manifest.json](vendor-manifest.json) 记录七个官方源码模块及原始 SHA-256：编辑器面板、消息桥、后继编辑器、选区存储、选区轮询、恢复界面、托管 daemon 通信。来源版本、修改与 MIT 许可见 [NOTICE.md](NOTICE.md)。
- [vendor-official.mjs](scripts/vendor-official.mjs) 与 [editor-patches.mjs](scripts/editor-patches.mjs) 可在源码仓库中复现这些副本和必要修改。Studio 不复制原生编辑器应用；运行时二进制和 Wasm/Web 资源来自固定版本的官方依赖。
- [native.ts](src/native.ts) 转发经过核实的原生节点、页面、组件、资源和查询工具。原生文件打开/保存、任意文件路径、进程操作、高层生成控制器等不直接暴露。工具参数删除上游描述、示例和文件字段，使用中立说明。
- [creation.ts](src/creation.ts) 使用独立 QuickJS 捕获 I/K，原生运行时分配真实 ID，再通过版本 CAS 保留明确创作的字段。这一步是必要的：上游即使 postProcess:false，也可能改写文字颜色和高度；仅改工具描述不能保证中立。
- Studio 自身包含会话工作台、顶部 OpenPencil 页签、聊天文件导航、可选 Better Sidebar 适配和文件打开授权。相关客户端代码位于 [workbench](src/workbench)，请求校验位于 [transport.ts](src/transport.ts)，文件打开入口位于 [file-open.ts](src/file-open.ts)。

工作台与原生编辑器、最近文件列表、选区引用共用 Studio 内部接口。切换会话或返回 Chat 时保留同一个编辑器 iframe；切换文件与关闭画布仍遵守保存状态和未保存修改保护。文件打开使用 /_dsh/openpencil-studio/open，与模型工具共用 Studio 的会话和路径授权，不依赖独立工作区插件或官方发行包补丁。

## 工具流程

所有模型工具统一使用 pencil_ 前缀。文档工具绑定明确的 .op 路径和调用所属的 DSH 会话；pencil_recent 使用调用会话的工作区。插件只注册这套工具名称，避免同一功能重复暴露。

编辑器没有活动草稿时显示“最近打开”，不再自动恢复浏览器 localStorage 中的最后一个文件。记录由 Host 维护在所属工作区的 .dsh/openpencil/recent.json，按真实路径去重，最新打开的文件在最上面；用户可手动移除记录，文件本身不会被删除。每次打开仍重新授权和取得当前会话的入口，列表不持久化授权或 presentation grant。pencil_recent 的 action:list/remove 与界面操作使用同一存储实现。记录写入失败只报告元数据错误，不把已经成功的文件打开伪装成失败。

选中画布内容后，顶栏显示“引用选区”按钮。点击捕获真实浏览器画布的当前选中子树，包含未保存内容；通过选区、页面和修订检查后，向对话输入框插入独立的结构化快照，再切回对话，不自动发送。快照保留文件路径、页面、节点 ID、修订和捕获时间，不依赖易失的内存 ID；重复选中的后代只保留在其祖先子树中，内容限制为 256 KiB。捕获或输入框版本变化时拒绝插入，保留用户原有输入。引用服务不可用时明确报错。选区引用不授权模型直接编辑。

恢复提示点击取消后，按作者内容 hash 持久记录本次忽略；保留恢复快照，同一内容不再反复提示，新的作者内容仍可提示。保存时若恢复内容与已保存内容相同，清除等价恢复入口。

1. pencil_create 创建新原生文件，或 pencil_open 打开已有文件；路径已有时创建拒绝覆盖。
2. pencil_catalog 查询当前可用的原生工具和技术 schema。原生 get_guidelines 返回技术说明；风格指南可主动查询，不自动选择或锁定。
3. 用 pencil_batch_design 的 script 创建节点，或使用 operations / 单节点工具增量修改。可以连续提交任意所需批次，也可以创建多个页面和顶层画板。
4. pencil_control_semantics 为实际控件 ID 保存 label 或 labelledBy 关联。引用必须是同一页面中含有效文字的文本节点或文本容器；空引用、自引用、其他控件和没有文字的节点不能充当标签。
5. pencil_validate 返回合并的技术诊断和真实节点修复目标。修正后再次验证；没有预设修复次数，也不重置计数伪装成功。
6. pencil_save 经校验和文件版本检查后原子保存。pencil_preview 按顶层画板生成独立 PNG，可指定一个画板。预览不替代保存。
7. pencil_status 查询状态；pencil_close 释放活动登记和 daemon，但保留未交付工作检查点。

script 是沙箱 QuickJS，只有 I(parent,node)、K(component,parent,overrides) 和普通 JavaScript；没有 Node、网络或文件 API。I/K 返回不透明字符串，只能按节点 ID 使用，不是可修改的对象。U/D/M/C/R/G 用于 operations，并保留为操作名称；本地辅助函数请使用 makeCard 等明确名称。提交前解析错误可修复，committed:false，不会终结任务。创建参数、编辑操作及 node_json / variables 的结构化 JSON 在原生调用前检查文件参数和图片 URI；普通文本中的路径描述不受影响。

batch_design 只接受一个非空 script 或 operations；空字符串会在调用原生工具前删除，两个非空入口或全空输入会被拒绝。operations 经静态检查后按一行一个调用提交，支持分号分隔输入而不改动文字中的操作符号。固定原生版本对同一批次 C 绑定后 M(binding,null,index) 的处理可能丢失原始根节点，因此这类组合在提交前返回 UNSUPPORTED_NATIVE_BATCH；应先复制，再用返回的真实节点 ID 单独移动。insert_node / update_node / replace_node 同时使用 data 和顶层几何、名称、kind、fill_hex 时，会先合并为一个节点参数；相同值允许，不同值返回 ARGUMENT_CONFLICT，避免原生工具静默忽略顶层字段。

pencil_undo / pencil_redo 撤销或重做模型工作副本中已完成的 Studio 文档事务，pencil_get_history_depth 返回对应历史深度。历史最多保留 32 步、合计 32 MiB；保存不清空历史，关闭、显式重新加载或检测到外部文档替换时清空，不跨进程持久保存。失败操作和仅改变选区、视口的操作不增加文档历史。用户脏画布、源文件冲突、写入租约及原生版本 CAS 保护同样适用于撤销重做。

真实资源限制为：脚本和展开的原生源码各 256 KiB、QuickJS 64 MiB 内存 / 1 MiB 栈 / 2 秒执行、4096 次插入、8 MiB 记录数据、原生文档 16 MiB。叶节点不能接收子节点。字段、字体、图标及控件类型必须由当前运行时支持；插件不假定完整字体或图标枚举接口存在。

## 未保存画布保护

浏览器画布和模型工作副本使用独立的原生 daemon；同一源路径由同一 DSH 会话拥有。模型编辑、校验、撤销重做、保存和重新加载都在工作副本中完成。干净画布无需确认写入锁：浏览器未打开、心跳失联、正在加载或处于错误状态时，都不会阻塞这些工具。Host 文档事务仍串行执行，事务期间拒绝交错的画布保存。客户端只上报已确认的作者内容变化和恢复草稿；等待快照、版本变化及桥接失败本身不标记为未保存修改，已有的未保存状态仍保留。

发现用户未保存的画布后，返回 UNSAVED_USER_CHANGES。模型必须先向用户询问，再将用户选择和**当前 editor.revision** 交给 pencil_resolve_unsaved：

- save-user：获取真实 iframe 快照，通过同一技术门禁保存后继续。
- discard-user：按已确认的修订丢弃用户画布并加载已保存文件。
- edit-saved：保留用户画布，允许下一次模型修改工作副本；之后仍需显式保存和重新加载，不自动覆盖画布。
- cancel：保持原画布和工作文件。

确认与具体修订绑定；后续用户修改使旧确认失效。选区仅是上下文，不是编辑授权。模型提交后只排队最新画布更新，不等待浏览器同步。画布恢复响应后，先锁定输入并读取真实 iframe 快照；只有内容仍与原画布基线相同、修订没有变化且没有未保存修改时才异步刷新。尚未上报的用户修改也会被快照检查识别并保留。旧更新的确认不能清除较新的更新；同步失败不会把已经成功的工具提交或文件保存变成失败。处理用户未保存画布的 save-user/discard-user 操作仍需要真实画布响应。

## 生命周期、恢复和校验

检查点位于 stateDirectory，默认 $DSH_HOME/state/openpencil-studio，按路径和会话隔离。没有自动过期清理。模型修改在每次成功提交后保存私有工作副本；前台脏画布持续变化时约每两秒捕获一次精确快照，正常结束会话前再尝试捕获。

异常退出可能丢失最后一次快照之后的浏览器变化。原生 daemon 的回退快照被明确标为不精确，不能冒充 iframe 精确快照，也不能覆盖已有精确恢复数据。恢复界面沿用现有工作区确认流程；忽略恢复入口时保留快照文件。

session/flush 首先持久保存模型工作副本和元数据。脏画布的检查点命令超时、断连或未就绪时，保留原有精确恢复快照；没有精确快照时仅尝试保存明确标为不精确的原生回退数据。此类画布故障返回 EDITOR_CHECKPOINT_UNAVAILABLE 警告，并通过 pencil_status 的 editor.checkpointWarning 和 Host 日志报告，不再阻断下一次模型或工具步骤，也不会清除画布的未保存标记。工作检查点写入、恢复存储或恢复元数据损坏仍会使 flush 失败。

校验、原生查询、修改、画布打开和关闭共用每份文档的事务队列；校验切换页面时不会与其他原生操作交错。源文件 hash 在临时文件准备完成后、替换前检查，原生版本 CAS 防止同时提交互相覆盖。普通文件系统没有跨程序的原子比较替换，外部程序在最后检查与 rename 之间写入仍有竞态窗口。会话结束和插件卸载会尝试清理全部会话，即使某个检查点失败也继续释放其他进程和登记；检查点仍保留。画布基线只在安全刷新得到确认或用户明确保存后更新。

参数/脚本错误、校验失败、源文件冲突、恢复失败、预览失败和宿主异常分别返回实际 code、诊断与恢复条件。预览采用原生 get_screenshot 和独立临时 daemon，不依赖可选 Jian，也不把渲染异常变成空诊断或编辑失败。失败预览立即回收临时目录；成功预览可在当前文档活动期间读取，关闭文档或结束会话时释放授权并回收目录。预览目录清理不触及工作和恢复检查点。

技术门禁关注文档与 ID 合法性、控件语义、可见性及可识别的几何/布局问题。跨页面运行原生 lint 与几何诊断，统一返回真实 nodeId、来源和修复入口；只有可推断的修改才生成 patch。旋转图标、对比度、内容结构、导航组成及审美建议不会作为通用保存处方。

## 编辑器代理

编辑器 iframe 使用 DSH 页面同一 origin 下的 /_dsh/openpencil-studio/editor/<id>/canvas/。原生 daemon 仍在私有随机端口运行，浏览器通过 DSH 的现有 Web 服务取得 HTML、JavaScript、WASM、CanvasKit、字体资源及受控的文档、选区和事件流接口。启动脚本适配原生资源路径与 fetch / XMLHttpRequest / EventSource，事件流持续转发并在浏览器断开后取消上游连接。

每次请求重新核对活动编辑器及源文件授权；代理目标和原生凭据由 Host 绑定，不接受调用者切换 tenant、目标端口或令牌，也不转发 DSH cookie、Authorization 或原生重定向。文件打开/保存、设置和通用 MCP 入口不经此代理暴露，文件保存仍走现有 Studio 门禁。文档同步在 Host 写入租约期间被拒绝；画布检查点、保存和重新加载命令可以先提交原生待同步修改，以完成真实快照。消息桥继续校验 iframe 对象和 DSH origin。

## 已知限制

- 七个复用模块、两个内部 JS 模块、原生文档 CAS / MCP / Web 消息协议均依赖固定版本。升级需要重新核对边界、重生成 vendor 副本和重跑验收，不能只修改版本号。
- 原生 0.8.5 不保留节点上的 label / ariaLabel。Studio 将控件标签和引用保存在原生 string variable studio/accessibility 中并进行验证。这是持久的设计语义元数据，**不能等同于运行时 Wasm 画布已经实现 DOM ARIA**；导出产品代码时需消费这些关联。
- 当前本地图片文件 URI 和任意原生资源文件路径不直接开放；可用 data URI 或 HTTP(S) 图片。以后支持本地资源应走工作区授权入口，不能关闭路径检查。
- 原生节点操作以活动页面为上下文。跨页面修改前应显式切换页面；诊断会检查全部页面并恢复原来的活动页面。
- list_theme_presets 要求任意目录参数，无法符合 Studio 的路径边界，因此不暴露该工具。其他可用主题与风格工具以 pencil_catalog 为准。
- 固定原生版本会在 tools/list 列出 37 个预置 insert_* UI 工具，但 tools/call 实际无法注册并执行它们；Studio 不暴露这些失效入口。insert_node、batch_design 的 I/K、组件工具和 list_ui_kits 仍可使用，目录不以虚构的按钮或套件实现替代原生能力。
- 宿主失败时保留工作，不自动重建或假装成功。检查点目前按原 DSH 会话归属恢复；没有跨会话所有权转移或自动空间清理工具。
- 多次修改仍使用原生工具各自的语义。创建适配器避免上游隐式样式改写，不承诺把用户主动执行的布局或组件操作变成无副作用的查询。

## 构建和验证

在本独立仓库根目录执行，需要 Node >=24.11.0 和 pnpm 11.15.0；依赖、锁文件、TypeScript 和格式化配置均由本仓库维护：

~~~sh
pnpm install --frozen-lockfile --ignore-scripts
pnpm test
node scripts/native-smoke.mjs
~~~

真实浏览器测试不下载 Chrome，需指定实际可执行的 Chromium：

~~~sh
node scripts/browser-fixture.mjs
# 使用 fixture 打印的独立随机端口：
STUDIO_CHROMIUM=/path/to/chromium node scripts/browser-acceptance.mjs http://127.0.0.1:PORT
# 完成后 POST fixture 的 /test/stop，正常释放原生进程。
~~~

Studio 的构建与回归覆盖真实原生编辑器代理、检查点失败传播、工作副本事务、会话页签切换、文件导航、选区引用和可选侧栏接入，并通过实际局域网监听地址验证 HTML、JS、WASM、CanvasKit、文档读取和状态回报。跨站请求、伪造 Host、不同端口、缺失 Origin 的写请求以及会话越权仍被拒绝。更新 Host 插件后需要重启 DSH，单独刷新页面不能保证加载新的 Host 代码。

编辑器自有顶栏保持 32px：左侧按钮收起或展开原生侧栏，文件名相对整个顶栏居中，保存与其他操作位于右侧。按钮通过同源 iframe 触发固定版本原生顶栏的 ToggleSidebar，并以原生可访问性镜像确认实际状态；未就绪、锁定或切换失败时不会假定成功。原生顶栏继续裁切。升级原生版本时需重新核对按钮命中位置 `(26,22)` 和镜像区域标识 `1000/5000`。这些控制器回归不替代真实浏览器的点击与视觉验收。

已有示例原生文件见 [software.op](examples/software.op)，独立预览见 [主界面](examples/preview-main.png)、[菜单](examples/preview-menu.png)、[弹窗](examples/preview-dialog.png)。

## 安装、启用与重启

先完成上述构建。使用本地源码包时，只安装并启用 Studio 入口：

~~~sh
dsh plugin --profile web add link:/home/HumXC/dsh-plugins/dsh-openpencil-studio
~~~

Studio 独立注册文件打开路由、顶部 OpenPencil 页面和导航适配；bundle 只包含 Studio。官方包只作为固定版本的代码和原生运行时依赖，不加载它的插件入口。

替换旧安装时，只保留 Studio 的启用入口并禁用旧官方 OpenPencil 插件。保存或保留当前画布后，由用户重启现有 Web 并刷新页面；安装和构建操作不自动重启服务。

重启前保存或保留正在使用的旧官方草稿；新插件不能认领旧官方的私有活动草稿。Studio 启动时若发现工作区宿主已占用会拒绝启动。若浏览器通过非默认 origin 打开 Web，应设置 allowedOrigin 为实际页面 origin；stateDirectory 可指定独立状态目录。

可对 Studio 运行 pnpm pack 生成安装包。会话工作台、文件导航和请求校验随 Studio 一起交付，不需要配套工作区代码包，也无需给官方插件发行文件施加补丁。

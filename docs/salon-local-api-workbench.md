# Salon 本机页面与接口联调

范围：独立分支开发工具，非正式 App、非上线验收。原 13 模块离线原型保持不变，三个既有 App 不接入。

## 启动与清理

在仓库目录运行 `node scripts/salon-local-integration.cjs`，打开终端打印的 `http://127.0.0.1:随机端口`。
需要本机 Docker 和 `postgres:15` 镜像。首次启动会回放全部 Salon 迁移，只创建当前进程专属的临时容器，不发布数据库端口、不读取云端凭据。
Ctrl+C 正常退出会删除该容器和其中合成数据。强制杀进程或主机断电可能残留名称为 `salon-workbench-进程号-时间戳` 的容器，需核对具体名称后单独清理，不能批量清理其他容器。

## 本批验证链路

页面 → 统一客户端 → 本机 HTTP → 实际 `createSalonHandler` → `service_role` → 实际 PostgreSQL RPC。

1. 显式连接本机测试身份，读取授权门店。
2. 在所选门店建立合成顾客，以服务端 ID 关联，不按姓名或旧 localStorage ID 关联。
3. 创建顾客订单草稿，独立保存所选商品明细，再读取订单核对。
4. 切换门店清空选择，未授权第三门店拒绝访问。
5. 模拟数据库提交后响应丢失，原请求重试只保留一份建档记录。
6. 退出会话立即清空业务选择；模拟退出响应丢失时保持锁定，重试退出成功后才允许重连；服务端撤销合成会话后拒绝后续建档。
   建档、草稿、明细即使已成功写入，后续回读失败仍保留待核对清单；只开放只读核对，不允许再发原写入或新建业务。草稿创建也须读取当前订单，只有当前为草稿才启用明细保存。
7. 当前店取消复核：批准释放档期，拒绝保留原预约；已到店/关联订单等例外拒绝自动处理。具体范围见 `salon-booking-cancel-review.md`。
8. 已确认预约同手艺人/同时长改期：原时间与版本校验、冲突回滚、审计和原请求重试。测试控件使用明确 UTC，范围见 `salon-booking-reschedule.md`。

接口客户端不保存 token、业务正文或余额到浏览器存储；金额从元精确转换到整数分用于页面映射，向接口提交时按现有元单位契约转换。所有资金计算仍由服务端负责。
前端范围与 ID 检查不能代替后端鉴权；后端仍逐请求验证身份、门店和资源权限。

冻结业务参数仅保存在当前页面内存中，未知结果时限制继续操作并提供原请求重试。建档/开单/明细三类额外将原请求号、操作类型及范围保留在本标签页 sessionStorage，刷新后重新验证身份并人工只读核对；不持久化业务正文。关闭标签页、正式过期会话重认证与跨设备恢复尚未实现；不允许把此工具当生产客户端使用。详见 `salon-request-lookup.md`。

## 测试

- `node scripts/test-salon-api-client.mjs`：ID、金额、冻结参数、重复点击、手动重试、切店旧响应隔离。
- `node scripts/test-salon-session.mjs`：Auth 契约替身测试，覆盖服务端身份不一致、过期、账号切换、令牌刷新、旧请求返回、退出失败、密码恢复状态与订阅清理。
- `NODE_PATH=/Users/a1/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules node scripts/test-salon-workbench.cjs`：Chrome 1280/390 宽度，真实本机 HTTP/处理器/PostgreSQL，合成记录与金额校验、响应丢失重试、跨店/来源限制、脚本字符安全呈现、无 localStorage 写入。结束自动删除测试容器。

本机身份验证是明确标记的合成替身，不是 Supabase Auth 或 Edge 运行时测试。读取资源与写入操作按开发工具白名单开放，收银、会员扣款、支付渠道均不在此工具开放范围内。
下一步仍需正式会话接入、原型模块迁移到统一数据层、预约/服务的持久化与完整订单到收银编排；本批不能证明整个 App 已完成。

## 会话接入边界（D1 第七批）

`session-controller.mjs` 接收显式初始化的 Salon 专属 Auth 实例，使用 `getSession` 取得令牌、`getUser(token)` 核对身份；组织/门店/员工/权限仍由业务 API 查询实际绑定，不使用 `user_metadata` 授权。
`onAuthStateChange` 回调保持同步，不在 Auth 事件锁中调用异步 SDK 方法。退出、换人、密码恢复或账号更新清除上下文；同一用户令牌刷新保留请求票据。未知身份或异步过期响应不能继续提交。

退出调用 `signOut({scope:'local'})`，不注销该用户其他设备。页面立即锁定，服务器退出失败时仍锁定且允许重试；不要把前端锁定误称为所有旧 JWT 立即失效。Supabase 现有访问令牌的有效期与服务端撤销策略必须在真实环境另行验证。本机合成令牌使用内存集合即时撤销，只是测试替身，不代表真实 Supabase 的撤销语义。

尚未选择或初始化正式 SDK/项目，没有新增生产配置、依赖下载、账号创建或登录请求。真实验收前需要确认专用测试项目、公开 publishable key 的配置方式、测试员工 Auth 绑定、登录方式、MFA/会话持久化策略及 Edge 部署。不得自行复用现有三个 App 的 SDK 会话或清空它们的 localStorage。

会话结束时旧请求票据失效，但不能据此断言已经发出的数据库写入回滚。中途退出、刷新后的未知结果核对和跨会话恢复仍须补充，不允许盲目新建同一业务。

实现参考（2026-09-06 核对）：[Auth 事件](https://supabase.com/docs/reference/javascript/auth-onauthstatechange)、[getSession](https://supabase.com/docs/reference/javascript/auth-getsession)、[signOut](https://supabase.com/docs/reference/javascript/auth-signout)。

## 会话等待异常保护（2026-09-06）

- 每次 getSession、getUser、signOut 独立等待最多 30 秒；这是每一步上限，不是完整连接流程总耗时。Auth 方法不添加未定义的 AbortSignal 参数，超时后底层 SDK 可能继续执行。
- 会话读取或身份验证超时即锁定并清除业务上下文，重新连接必须重新验证身份；迟到结果不设置身份，不发送后续业务请求。
- 退出开始就锁定。超时/失败只开放“重试退出”，迟到 SIGNED_OUT/SIGNED_IN 事件和迟到成功结果都不能解除退出待确认状态。手动退出重试确认后才能重新连接。
- 两端本机合成登录包含 fetch 和响应正文的超时保护；顾客退出请求同样有等待上限。合成员工退出保留原测试令牌用于重试，不读取其他 App 存储。
- 专项：`NODE_PATH=/Users/a1/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules node scripts/test-salon-session-timeouts.cjs`，验证 1280/390 员工/顾客端登录响应与正文卡住、身份验证超时、退出迟到锁定、原合成令牌重试及再次连接。测试无业务写入，容器正常结束后清理。
- 安全检查：未新增依赖/密钥/数据库权限，不使用 user_metadata 授权；保留 getUser 服务端验证和 local 范围退出。未运行线上 Advisor、未部署 Auth/Edge。真实 JWT 不等于本机可即时撤销的合成令牌，正式撤销策略仍需独立验收。
- 本批只恢复可控的等待/退出交互，不恢复已失效请求票据；刷新、账号过期和跨设备后的未知写入核对仍待开发。

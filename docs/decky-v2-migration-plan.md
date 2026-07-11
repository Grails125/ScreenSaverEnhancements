# Decky Loader V2 现代 API 迁移方案

## 状态

- 状态：阶段 1 真机验收通过，准备实施阶段 2
- 目标分支：`v2`
- 编写日期：2026-07-11
- 最近更新：2026-07-11
- 当前验证设备：Decky Loader 3.2.6
- 当前基线：`feature/optimization` 的现有功能与行为

本文只记录迁移设计、实施顺序和验收标准。创建本方案时不修改插件前端、后端、构建配置、依赖、测试或发布产物。

## 背景

当前插件仍采用 Decky Loader 的旧式加载和调用模型：

- 前端构建为 IIFE。
- UI 和 Loader 接口来自 `decky-frontend-lib`。
- `definePlugin` 接收 `ServerAPI`。
- 前端通过 `serverApi.callPluginMethod()` 调用后端。
- 后端导入 `decky_plugin`。
- 插件事件主要通过长轮询传递。

Decky Loader 当前源码将插件加载类型明确区分为：

- `LEGACY_EVAL_IIFE`：旧 IIFE 格式及 legacy `serverAPI`。
- `ESMODULE_V1`：ES Module 格式及现代 Decky API。

因此，仅包装或替换个别 `callPluginMethod()` 调用不能完成迁移，也不能可靠消除 legacy 警告。V2 必须同时迁移构建格式、前端 API 和 RPC 调用方式。

## 官方依据

- [Decky Loader 插件加载类型](https://github.com/SteamDeckHomebrew/decky-loader/blob/main/frontend/src/plugin.ts)
- [Decky 官方插件模板前端](https://github.com/SteamDeckHomebrew/decky-plugin-template/blob/main/src/index.tsx)
- [Decky 官方插件模板后端](https://github.com/SteamDeckHomebrew/decky-plugin-template/blob/main/main.py)
- [Decky 官方插件模板 Rollup 配置](https://github.com/SteamDeckHomebrew/decky-plugin-template/blob/main/rollup.config.js)
- [Decky 官方插件模板依赖配置](https://github.com/SteamDeckHomebrew/decky-plugin-template/blob/main/package.json)
- [Decky Loader Wiki](https://wiki.deckbrew.xyz/)

Wiki 的入门示例仍包含 `ServerAPI` 和 `callPluginMethod()`。若 Wiki 与当前 Loader 源码或官方模板存在冲突，以当前 Loader 源码和官方模板为迁移依据。

## 迁移目标

1. 使用 Decky 的 `ESMODULE_V1` 插件格式加载。
2. 使用 `@decky/ui` 提供界面组件。
3. 使用 `@decky/api` 提供 `definePlugin`、`callable`、通知、路由和事件接口。
4. 使用 `@decky/rollup` 构建插件。
5. 将前后端调用改为显式、类型化的 RPC 契约。
6. 保持现有用户设置和所有已验证功能行为不变。
7. 在确认事件可靠性后，再考虑以事件推送替换长轮询。
8. 在 Decky Loader 日志中不再出现本插件的 legacy 插件警告。

## 非目标

V2 迁移期间不顺带进行以下工作：

- 不重新设计插件界面。
- 不改变休眠、息屏或抑制规则的业务语义。
- 不改变现有设置键名和持久化格式。
- 不在首轮迁移中同时重写事件系统。
- 不为了迁移清理无关代码。
- 不在同一发行包内维护 IIFE 与 ESM 双运行时实现。

## 当前迁移范围

### 构建与依赖

- 将 Rollup 2 配置迁移至 `@decky/rollup`。
- 将项目模块类型迁移为 ESM。
- 升级 Rollup、TypeScript 和相关类型依赖至官方模板兼容版本。
- 将 `decky-frontend-lib` 拆分为 `@decky/ui` 与 `@decky/api`。
- 调整测试工具，使其能够处理 ESM 和新的模块导入。

依赖版本不直接照抄模板最新版。实施时应先确认 Decky Loader 3.2.6 与目标模板版本的兼容性，并锁定经过真机验证的版本组合。

### 前端接口

- 将 `definePlugin((serverApi) => ...)` 改为现代入口形式。
- 将 UI 组件导入迁移至 `@decky/ui`。
- 将通知、路由、callable 和事件接口迁移至 `@decky/api`。
- 将 `serverApi.toaster` 替换为现代通知接口。
- 单独验证全局黑屏覆盖组件依赖的路由或全局组件注册能力。

全局黑屏覆盖是兼容性验证的阻断项。如果现代 API 不能等价注册和卸载该组件，不继续进行批量 RPC 迁移，先确定官方支持的替代实现。

### RPC 契约

计划迁移的现有后端方法：

1. `start_backend`
2. `stop_backend`
3. `is_running`
4. `get_running_processes`
5. `get_inhibit_status`
6. `get_diagnostics`
7. `get_system_power_settings`
8. `get_power_override_state`
9. `begin_power_override`
10. `end_power_override`
11. `wait_for_events`
12. `get_settings`
13. `set_settings`
14. `set_settings_batch`

每个方法使用 `callable<参数元组, 返回值>()` 建立类型契约。现代 callable 直接返回后端结果，失败通过 Promise 异常传播，因此必须移除旧的 `{ success, result }` 判断，统一错误处理和用户提示。

### 后端

- 将 `decky_plugin` 迁移为当前官方模板使用的 `decky`。
- 验证日志器、插件目录、设置目录和运行目录常量。
- 保持方法名、参数和返回结构稳定，先降低前后端同时变化的风险。
- 保持电源恢复、D-Bus 抑制、进程监控和更新检查逻辑不变。

### 事件

第一阶段继续通过 `wait_for_events` 长轮询传递状态事件，但调用入口改为现代 callable。这样可以将加载格式和 RPC 迁移与事件语义变更分开验证。

只有满足以下条件后，才迁移至 `decky.emit()` 和 `addEventListener()`：

- 插件面板关闭和重新打开后能够恢复完整状态。
- 前端尚未加载或临时断开时不会永久丢失关键状态。
- 后端同步监控代码能够安全地调度异步事件。
- 卸载、Loader 重启和 Steam UI 重启时能够正确清理监听器。
- 事件推送失败不会妨碍恢复系统电源设置。

## 实施阶段

### 阶段 0：兼容性验证

目标是证明迁移路径可行，不承载完整功能。

- 使用 `@decky/rollup` 构建最小 ESM 插件入口。
- 迁移一个只读方法，优先选择 `get_diagnostics`。
- 在 Decky Loader 3.2.6 上确认插件能够加载。
- 确认 Loader 日志中不再出现 legacy 警告。
- 验证插件面板、通知接口和卸载流程。
- 验证全局黑屏覆盖组件能够注册、显示和可靠卸载。

通过条件：以上全部成功，且恢复旧版产物后行为正常。

### 阶段 1：现代 UI 外壳

- 完成构建工具和依赖迁移。
- 迁移 `definePlugin`、UI 组件、路由和通知接口。
- 保持后端功能、方法签名和长轮询行为不变。
- 修复测试桩和类型错误。

通过条件：插件全部页面可打开，设置能够读取，黑屏覆盖正常，尚未迁移的功能不会被误触发。

### 阶段 2：分组迁移 RPC

按风险从低到高迁移：

1. 设置与诊断。
2. 后台启动、停止和运行状态。
3. 进程与抑制状态。
4. 系统电源设置和电源覆盖。
5. 事件长轮询。

每组独立构建、测试、真机验证和提交。禁止一次性替换全部调用。

### 阶段 3：后端模块迁移

- 切换至 `import decky`。
- 验证所有 Decky 常量和日志行为。
- 验证 Loader 启动、插件卸载和异常恢复路径。
- 保持当前事件队列实现。

### 阶段 4：可选事件推送迁移

- 为非关键状态建立 `decky.emit()` 试点。
- 前端挂载时先执行一次完整状态同步，再订阅增量事件。
- 保留超时后的状态重取机制。
- 逐步替换长轮询，最后才删除旧队列代码。

此阶段是独立优化，不作为消除 legacy 警告的前置条件。

## 测试与验收

### 构建与静态检查

- 现代 Rollup 构建成功。
- TypeScript 类型检查通过。
- 自动化测试通过。
- 产物采用 Decky 支持的 ESM 格式。
- 不残留 `decky-frontend-lib` 或 `callPluginMethod` 运行时调用。

### 真机功能回归

- 插件面板正常显示、关闭和重新打开。
- 所有设置保留，旧版本设置无需重置即可读取。
- 修改系统电源设置后，重新打开面板能够同步系统真实值。
- 自定义电源配置可以写入、停用和恢复。
- 休眠前通知和手柄取消倒计时行为不变。
- WiliWili、DeckyMusic 和视频播放等抑制来源能够正确显示。
- 相同抑制状态不会重复通知。
- 黑屏覆盖、自动息屏和恢复行为正常。
- 更新检查、版本说明和诊断报告复制正常。
- Loader、Steam UI 或插件异常退出后不会遗留错误的系统电源设置。

### Loader 验收

- Decky Loader 3.2.6 能够稳定加载插件。
- Loader 日志中不再出现本插件的 legacy 加载或 legacy method calls 警告。
- 插件卸载后不残留前端组件、事件监听器或后端任务。

## 风险与应对

### 全局覆盖组件不兼容

风险：现代 API 可能没有与当前 `addGlobalComponent` 完全相同的公开行为。

应对：将其设为阶段 0 阻断项；优先查证 Loader 源码和当前 API 类型，不以私有接口作为正式方案。

### 新旧返回语义混用

风险：旧代码把 callable 的直接返回值当作 `{ success, result }`，导致正常结果被判定为失败。

应对：为 14 个方法集中定义类型契约，按领域逐组迁移并测试错误路径。

### ESM 与测试环境差异

风险：生产构建成功，但测试仍依赖 CommonJS 或旧模块模拟。

应对：在阶段 0 同时建立最小 ESM 构建测试，不延后处理测试基础设施。

### 事件丢失或乱序

风险：直接从长轮询改为推送后，面板未加载时丢失状态，影响休眠和抑制展示。

应对：首轮保留长轮询；后续事件实现采用“挂载时全量同步 + 增量事件 + 超时重同步”。

### 旧 Decky Loader 不兼容

风险：ESM 和当前 Decky API 可能不支持较旧的 Loader。

应对：以实测结果确定最低 Loader 版本，在插件元数据和发布说明中明确要求，不在一个产物中维护双格式。

## 回滚策略

- V2 迁移独立于当前稳定分支开发。
- 每个阶段均生成可识别的真机测试产物。
- 部署前备份 Deck 上当前插件目录和设置。
- 发生阻断问题时停止 Loader、恢复旧产物，再启动 Loader。
- 回滚不得删除或重置用户设置。
- 未通过完整验收前，不用 V2 覆盖稳定发布版本。

## 预计工作量

- 涉及约 8～12 个文件。
- 预计约 600～1000 行有效变更。
- 构建、接口迁移和本机测试约 0.5～1 个工作日。
- Deck 真机回归约 0.5～1 个工作日。
- 若全局覆盖组件需要替代实现，可能额外增加约 1 个工作日。

该估算不包括新增功能或界面重设计。

## 开始实施前的决策门槛

满足以下条件后才开始修改代码：

1. 确认目标最低 Decky Loader 版本。
2. 确认 `@decky/api`、`@decky/ui` 和 `@decky/rollup` 的兼容版本组合。
3. 确认现代 API 下全局黑屏覆盖组件的公开实现路径。
4. 确认旧设置数据必须原样兼容。
5. 确认先保留长轮询，事件推送另行实施。
6. 准备 Deck 上可立即执行的旧版本回滚包。

## 当前结论

V2 应采用完整 ESM 迁移，不在旧 IIFE 架构上继续包装 legacy API。阶段 0 的最小兼容性验证和阶段 1 的现代 UI 外壳迁移均已通过 Decky Loader 3.2.6 真机验收；下一步按风险分组推进 RPC 迁移，最后独立评估事件推送。

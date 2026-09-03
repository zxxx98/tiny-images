# 用户自助注册设计

## 目标

新增可选的「用户注册」能力：管理员在「管理后台 → 设置」控制开关（默认关闭）。开启后登录页出现「注册新账号」入口，访客在 `/register` 页面使用邮箱和密码自助注册，注册即登录进入 Playground。新账号为普通用户角色，默认每日 30 张生图额度（管理员可在设置页调整默认值，也可在「用户」中按账号修改）；已注册用户沿用页眉「改密码」自行修改密码。关闭开关只影响新注册，已有账号不受影响。

## 数据模型

复用现有 `settings` 键值表，不新增数据库迁移：

- `registration_enabled`：`"1"` / `"0"`，默认 `"0"`（关闭）。
- `registration_daily_quota`：正整数字符串，默认 `"30"`。

`AppSettings` 增加 `registration: { enabled, dailyQuota }`；读取时对非法值回退到默认（关闭 / 30）。`updateAppSettings` 接受可选 `registration` 字段，缺省时保留当前值（与 `promptOptimizer` 同一模式），仍在单事务内保存。

## 服务端接口

- `GET /admin/auth/register`（公开）：返回 `{ enabled }`，供前端决定是否展示注册入口。
- `POST /admin/auth/register`（公开，无需登录）：
  - 未开启时返回 403 `user registration is disabled`；
  - 校验邮箱格式与密码长度（≥ 6），与首次设置、管理员建号的规则一致；
  - 创建 `role: "user"`、`quotaTotal = registration.dailyQuota`、启用的账号，邮箱唯一冲突返回 409；
  - 成功返回 201 与 7 天期 JWT `{ token, role, email }`，注册即登录。
- `GET/PUT /admin/settings`：PUT 增加可选 `registration` 对象（`enabled` 必须为布尔、`dailyQuota` 必须为正整数，否则 400），仅管理员可访问（沿用现有鉴权）。

注册用户改密码复用现有 `PUT /admin/auth/password`（`requireUser` 对所有登录用户可用），无服务端改动。

## 前端

- `api.ts`：`AppSettings`/`saveSettings` 增加 `registration`；新增 `fetchRegistrationEnabled()` 与 `registerRequest()`。
- 新增 `/register` 页面（React Router 路由，公开访问）：沿用登录/首次设置页的 `.login-wrap + .card.login-card + .login-hero(rainbow)` 结构与按钮、错误提示样式；包含邮箱、密码、确认密码三个输入框，前端先校验两次密码一致，成功后清旧 token、写入新 token 与角色并跳转 Playground。开关关闭时展示「当前未开放注册」卡片与「返回登录」按钮；开关探测失败时保留表单，由提交时的服务端 403 兜底。
- 登录页挂载时探测 `GET /admin/auth/register`，开启时在登录按钮下方显示「没有账号？注册新账号」链接，关闭或探测失败不显示。
- 设置页新增「用户注册」区块：启用复选框 + 「注册用户每日额度（张）」数字输入框（提交前校验正整数），说明文案与新账号的默认额度语义一致；随「保存设置」一并提交。
- `styles.css` 仅新增 `.register-alt`（卡片内辅助链接）、`.register-closed-tip`、`.register-link` 与 `.check-row`（复选框行）等少量辅助样式，全部复用现有配色与斜面变量。

## 配额语义

新注册账号的 `quota_total` 即现有「每日额度」语义：`quota_day` 按北京时间日切重置 `quota_used`，执行器按成功生成张数扣减。因此「默认每日 30 张」直接由 `quota_total = 30` 表达，无需新增字段。

## 测试

- 服务端：`server/tests/register.test.ts` 覆盖开关查询、关闭时 403、默认/自定义额度、邮箱冲突 409、参数校验 400、注册用户改密码与角色权限、settings 缺省保留与非法 payload；`store.test.ts`、`admin.test.ts` 的 settings 断言补充 `registration` 字段。
- 前端：`SettingsTab.test.tsx` 覆盖开关与额度的保存及非法额度拦截；`Register.test.tsx` 覆盖关闭提示、注册成功写 token、密码不一致与 409 文案；`App.test.tsx` 为登录页探测补充 mock。
- e2e：`server/scripts/e2e.ts` 增加「关闭时 403 → 开启 → 注册 → 30/30 额度 → 改密码」流程；同时修复脚本里遗留的 `provider` → `providers` 注册表参数，使其在 ProviderRegistry 重构后可运行。

# 设计：渠道分组、用户角色与额度

日期：2026-08-30
状态：已确认

## 目标

在 tiny-images 生图聚合网关上增加：

1. 渠道分组：渠道按组归类，生图请求只路由到用户所属组内的渠道。
2. 角色管理：admin / 普通用户两类角色，admin 可创建和管理普通用户；登录改为邮箱+密码（JWT）。
3. 额度：按生图张数计费，admin 为每个普通用户配置可用额度。

## 现状

- SQLite（node:sqlite），migration 为 `server/src/store/db.ts` 中的 `MIGRATIONS` 数组（当前 v2）。
- 认证：对外 `/v1` 用 Bearer api key（`api_keys` 表，空表不鉴权）；管理接口用环境变量 `ADMIN_TOKEN`，无用户表。
- 无额度/计费概念；渠道无分组；`models` 表做模型映射（public_name → channel_id）。
- 前端 React + react-router，token 存 localStorage，`Login.tsx` 只输入 ADMIN_TOKEN。

## 1. 渠道分组（多对多）

### 数据模型（migration v3）

```sql
CREATE TABLE channel_groups (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE channel_group_members (
  group_id INTEGER NOT NULL REFERENCES channel_groups(id) ON DELETE CASCADE,
  channel_id INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  UNIQUE(group_id, channel_id)
);
```

### API（均需 admin）

- `GET /admin/groups`：列表（含组内渠道 id 列表）。
- `POST /admin/groups`：`{ name }`。
- `PATCH /admin/groups/:id`：改名。
- `DELETE /admin/groups/:id`：删组（成员关系级联，渠道本身不动）。
- `PUT /admin/groups/:id/channels`：`{ channelIds: number[] }` 全量替换组内成员。

### 路由行为

`core/router.ts` 选渠道时按传入的“允许的渠道 id 集合”过滤：

- admin、或未配置任何分组的用户 → 全部启用渠道。
- 配置了分组的普通用户 → 其所有组成员的并集 ∩ 启用渠道。
- 模型映射 `models` 表指向不在允许集合内的渠道时，该模型对该用户不可用（`/v1/models` 与生图请求同样过滤）。

### 前端

Admin 页新增「分组」Tab：建组、改名、删除、勾选渠道成员。

## 2. 用户与角色

### 数据模型

```sql
CREATE TABLE users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,        -- node:crypto scrypt: salt:hash(hex)
  role TEXT NOT NULL CHECK (role IN ('admin','user')),
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
ALTER TABLE api_keys ADD COLUMN user_id INTEGER REFERENCES users(id) ON DELETE SET NULL;
```

普通用户的额度与渠道组配置（migration v3 一并完成）：

```sql
ALTER TABLE users ADD COLUMN quota_total INTEGER;    -- NULL = 不限量（仅限 admin）
ALTER TABLE users ADD COLUMN quota_used INTEGER NOT NULL DEFAULT 0;
CREATE TABLE user_group_members (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  group_id INTEGER NOT NULL REFERENCES channel_groups(id) ON DELETE CASCADE,
  UNIQUE(user_id, group_id)
);
```

### 认证

- `POST /admin/auth/login` `{ email, password }` → `{ token, role, email }`。JWT（HS256，payload 含 `uid`、`role`、`exp`，有效期 7 天）。
- `JWT_SECRET`：环境变量优先；未设置时首次启动生成随机 secret 并持久化到 `<DATA_DIR>/jwt_secret`。
- 初始 admin 种子：users 表为空时，读 `ADMIN_EMAIL`/`ADMIN_PASSWORD` 创建 admin；未设置则创建 `admin@local` + 随机密码并打印到启动日志。
- 兼容：`ADMIN_TOKEN` 仍可直接作为管理接口与 `/v1` 的 Bearer 凭证（视为 admin）。`makeRequireAdmin` 改为：JWT（role=admin）或 ADMIN_TOKEN 任一通过。普通用户 JWT 只能访问非 admin 接口。
- `PUT /admin/auth/password`：当前登录用户（任意角色）修改自己的密码 `{ oldPassword, newPassword }`。

### 用户管理 API（admin only）

- `GET /admin/users`：列表（含额度使用、所属组）。
- `POST /admin/users`：`{ email, password, quotaTotal, groupIds }`（quotaTotal 必填、>0；groupIds 可空=不限组）。
- `PATCH /admin/users/:id`：改 `enabled`、`quotaTotal`、`groupIds`、重置密码（`password` 字段）；role 不可改、admin 账号不可禁用/删除自己。
- `DELETE /admin/users/:id`：删除普通用户（其 api_keys 的 user_id 置 NULL）。

### 前端

- `Login.tsx`：邮箱+密码表单。
- Admin 页新增「用户」Tab：列表 + 创建/编辑弹窗（邮箱、初始密码、额度、渠道组多选）、启停、重置密码。
- 路由守卫：非 admin 访问 `/admin` 重定向 `/`；顶部导航对普通用户显示剩余额度（`GET /admin/auth/me` 返回当前用户信息与额度）。
- 用户可自行改密码（导航下拉或简单入口，最低成本：在导航放「修改密码」弹窗）。

## 3. 额度（生图张数）

- 计量：成功生成一张图扣 1 次；一次请求生成 n 张扣 n。
- 校验：请求进入时检查剩余（`quota_total - quota_used >= 预计张数`，预计张数取请求 `n`，缺省 1）；不足返回 HTTP 402 `{ error: { message: "quota exceeded" } }`。
- 扣减：生成成功后条件更新 `UPDATE users SET quota_used = quota_used + n WHERE id = ? AND quota_used + n <= quota_total`；若条件更新失败（并发下超额）记日志，不回滚已生成的图。admin 与 quota_total 为 NULL 的用户不校验不扣减。
- Playground 用户可见自己的剩余额度；admin 页用户列表可见使用情况。

## 4. `/v1` API key 绑定用户

- `requireApiKey` 解析 key 后查 `user_id`：
  - key 无主（含空表不鉴权的旧行为、ADMIN_TOKEN）：不扣额度、不限渠道。
  - key 有主：查用户 enabled/quota/渠道组，路由过滤 + 成功后扣额度。
- Admin 的「Keys」Tab 创建 key 时可选关联用户。

## 5. 错误处理

- 额度不足：402。禁用用户/被删用户的有效 JWT：401（`/admin/auth/me` 与每次鉴权时查库校验 enabled）。
- 分组被删：用户成员关系级联删除，属自动收紧权限，无迁移问题。
- JWT secret 丢失：所有已发 token 失效，重新登录即可，无数据风险。

## 6. 测试

沿用 server 现有测试方式（vitest e2e/单测），新增：

- 登录：正确/错误密码、禁用用户、ADMIN_TOKEN 兼容。
- 权限：普通用户访问 admin 接口 403；普通用户 JWT 可访问非 admin 接口。
- 用户管理：创建、改额度、改组、重置密码、不可自删。
- 分组：CRUD、成员替换、级联删除。
- 额度：n 张扣 n、超额 402、并发扣减不超支、NULL 额度不限。
- 路由过滤：用户仅能命中其组内渠道；`/v1/models` 过滤一致。

## 不做的事（YAGNI）

- 不做额度充值/流水表，只在 users 上累计 quota_used。
- 不做刷新 token / 记住我，过期重新登录。
- 不做邮箱验证、找回密码。
- 不做多 admin 层级，admin 权限一律等同。

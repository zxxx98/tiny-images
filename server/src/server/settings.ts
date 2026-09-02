import type { AppContext } from "../app.js";
import { httpError } from "../core/errors.js";
import { requireBody } from "./admin.js";

function requireText(body: Record<string, unknown>, field: string): string {
  const value = body[field];
  if (typeof value !== "string") throw httpError(400, `'${field}' must be a string`);
  return value;
}

// AI 提示词优化配置：三个字段都必须是字符串（可为空 = 未启用）
function requirePromptOptimizer(value: unknown): { baseUrl: string; apiKey: string; model: string } {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw httpError(400, "'promptOptimizer' must be an object");
  }
  const source = value as Record<string, unknown>;
  return {
    baseUrl: requireText(source, "baseUrl"),
    apiKey: requireText(source, "apiKey"),
    model: requireText(source, "model"),
  };
}

// 用户注册配置：enabled 为布尔，dailyQuota 为正整数（新注册账号的默认每日额度）
function requireRegistration(value: unknown): { enabled: boolean; dailyQuota: number } {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw httpError(400, "'registration' must be an object");
  }
  const source = value as Record<string, unknown>;
  if (typeof source.enabled !== "boolean") throw httpError(400, "'registration.enabled' must be a boolean");
  if (typeof source.dailyQuota !== "number" || !Number.isInteger(source.dailyQuota) || source.dailyQuota <= 0) {
    throw httpError(400, "'registration.dailyQuota' must be a positive integer");
  }
  return { enabled: source.enabled, dailyQuota: source.dailyQuota };
}

export function registerSettings(ctx: AppContext): void {
  ctx.app.get("/admin/settings", { preHandler: ctx.requireAdmin }, async () => ctx.deps.repo.getAppSettings());

  ctx.app.put("/admin/settings", { preHandler: ctx.requireAdmin }, async (req) => {
    const body = requireBody(req);
    return ctx.deps.repo.updateAppSettings({
      globalPrompt: requireText(body, "globalPrompt"),
      announcement: requireText(body, "announcement"),
      ...(body.promptOptimizer === undefined
        ? {}
        : { promptOptimizer: requirePromptOptimizer(body.promptOptimizer) }),
      ...(body.registration === undefined ? {} : { registration: requireRegistration(body.registration) }),
    });
  });

  ctx.app.get("/v1/announcement", { preHandler: ctx.requireUser }, async () => {
    const settings = ctx.deps.repo.getAppSettings();
    return { announcement: settings.announcement, version: settings.announcementVersion };
  });
}

import type { AppContext } from "../app.js";
import { httpError } from "../core/errors.js";
import { WATERMARK_POSITIONS, type WatermarkPosition, type WatermarkStyle } from "../store/repo.js";
import { requireBody } from "./admin.js";

function requireText(body: Record<string, unknown>, field: string): string {
  const value = body[field];
  if (typeof value !== "string") throw httpError(400, `'${field}' must be a string`);
  return value;
}

// AI 提示词优化配置：三个字段都必须是字符串（可为空 = 未启用）
function requireChatUpstreamSettings(field: string, value: unknown): { baseUrl: string; apiKey: string; model: string } {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw httpError(400, `'${field}' must be an object`);
  }
  const source = value as Record<string, unknown>;
  return {
    baseUrl: requireText(source, "baseUrl"),
    apiKey: requireText(source, "apiKey"),
    model: requireText(source, "model"),
  };
}

const requirePromptOptimizer = (value: unknown): { baseUrl: string; apiKey: string; model: string } =>
  requireChatUpstreamSettings("promptOptimizer", value);

const requirePromptReverse = (value: unknown): { baseUrl: string; apiKey: string; model: string } =>
  requireChatUpstreamSettings("promptReverse", value);

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

// 下载水印集中样式：位置枚举、字号 12–128、不透明度 0.1–1、十六进制颜色、前缀 ≤40 字
function requireWatermarkStyle(value: unknown): WatermarkStyle {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw httpError(400, "'watermarkStyle' must be an object");
  }
  const source = value as Record<string, unknown>;
  if (typeof source.position !== "string" || !WATERMARK_POSITIONS.includes(source.position as WatermarkPosition)) {
    throw httpError(400, "'watermarkStyle.position' is invalid");
  }
  if (typeof source.fontSize !== "number" || !Number.isInteger(source.fontSize) || source.fontSize < 12 || source.fontSize > 128) {
    throw httpError(400, "'watermarkStyle.fontSize' must be an integer between 12 and 128");
  }
  if (typeof source.opacity !== "number" || source.opacity < 0.1 || source.opacity > 1) {
    throw httpError(400, "'watermarkStyle.opacity' must be a number between 0.1 and 1");
  }
  if (typeof source.color !== "string" || !/^#[0-9a-fA-F]{6}$/.test(source.color)) {
    throw httpError(400, "'watermarkStyle.color' must be a hex color like #ffffff");
  }
  if (typeof source.prefix !== "string" || source.prefix.length > 40) {
    throw httpError(400, "'watermarkStyle.prefix' must be a string of at most 40 characters");
  }
  return {
    position: source.position as WatermarkPosition,
    fontSize: source.fontSize,
    opacity: source.opacity,
    color: source.color,
    prefix: source.prefix,
  };
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
      ...(body.promptReverse === undefined ? {} : { promptReverse: requirePromptReverse(body.promptReverse) }),
      ...(body.registration === undefined ? {} : { registration: requireRegistration(body.registration) }),
      ...(body.watermarkStyle === undefined ? {} : { watermarkStyle: requireWatermarkStyle(body.watermarkStyle) }),
    });
  });

  ctx.app.get("/v1/announcement", { preHandler: ctx.requireUser }, async () => {
    const settings = ctx.deps.repo.getAppSettings();
    return { announcement: settings.announcement, version: settings.announcementVersion };
  });
}

import { ValidationError } from "../core/errors.js";

export interface CommonImageFields {
  n: number;
  size?: string;
  responseFormat: "url" | "b64_json" | "auto";
  stream: boolean;
  passthrough: Record<string, unknown>;
}

const SIZE_RE = /^(\d{3,4}x\d{3,4}|auto)$/;
const COMMON_FIELDS = new Set(["model", "prompt", "n", "size", "quality", "response_format", "stream"]);

export function validateCommonFields(b: Record<string, unknown>): CommonImageFields {
  let n = 1;
  if (b.n !== undefined) {
    // multipart 表单里所有字段都是字符串
    const nVal = typeof b.n === "string" ? Number.parseInt(b.n, 10) : b.n;
    if (!Number.isInteger(nVal) || (nVal as number) < 1 || (nVal as number) > 10) {
      throw new ValidationError("'n' must be an integer between 1 and 10");
    }
    n = nVal as number;
  }
  if (b.size !== undefined && (typeof b.size !== "string" || !SIZE_RE.test(b.size))) {
    throw new ValidationError("'size' must match '<width>x<height>' (e.g. 1024x1024) or 'auto'");
  }
  if (b.quality !== undefined && typeof b.quality !== "string") throw new ValidationError("'quality' must be a string");
  let responseFormat: "url" | "b64_json" | "auto" = "auto";
  if (b.response_format !== undefined) {
    if (b.response_format !== "url" && b.response_format !== "b64_json") {
      throw new ValidationError("'response_format' must be 'url' or 'b64_json'");
    }
    responseFormat = b.response_format;
  }
  let stream = false;
  if (b.stream !== undefined) {
    if (typeof b.stream !== "boolean") throw new ValidationError("'stream' must be a boolean");
    stream = b.stream;
  }
  const passthrough: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(b)) {
    if (!COMMON_FIELDS.has(k)) passthrough[k] = v;
  }
  return { n, size: b.size as string | undefined, responseFormat, stream, passthrough };
}

export function requireString(b: Record<string, unknown>, field: string): string {
  const v = b[field];
  if (typeof v !== "string" || v.length === 0) throw new ValidationError(`'${field}' is required`);
  return v;
}

import type { FastifyRequest } from "fastify";
import { ValidationError } from "../core/errors.js";
import type { IncomingImage, UnifiedVariationRequest } from "../core/types.js";
import type { AppContext } from "../app.js";
import { extractHistoryImages, fileBaseUrlFor, finishSync, recordGeneration, variationRecordMeta } from "./generations.js";
import { validateCommonFields } from "./validate.js";

// OpenAI images variations：multipart，仅一张源图，没有 prompt
export async function parseVariationMultipart(req: FastifyRequest): Promise<{ model: string; varReq: UnifiedVariationRequest }> {
  if (!req.isMultipart()) {
    throw new ValidationError("request must be multipart/form-data");
  }
  const fields: Record<string, unknown> = {};
  const images: IncomingImage[] = [];
  for await (const part of req.parts()) {
    if (part.type === "file") {
      const image: IncomingImage = {
        filename: part.filename || "image.png",
        data: await part.toBuffer(),
        mimeType: part.mimetype || "image/png",
      };
      if (part.fieldname === "image") images.push(image);
      // 其他字段名的文件忽略
    } else {
      fields[part.fieldname] = part.value;
    }
  }
  if (images.length === 0) throw new ValidationError("'image' file is required");
  if (images.length > 1) throw new ValidationError("'image' accepts exactly one file");

  const b = fields as Record<string, unknown>;
  const model = b.model;
  if (typeof model !== "string" || model.length === 0) throw new ValidationError("'model' is required");
  const common = validateCommonFields(b);
  if (common.stream) throw new ValidationError("'stream' is not supported for variations");
  return {
    model,
    varReq: {
      n: common.n,
      size: common.size,
      responseFormat: common.responseFormat,
      images,
      passthrough: common.passthrough,
    },
  };
}

export function registerVariations(ctx: AppContext): void {
  ctx.app.post("/v1/images/variations", { preHandler: ctx.requireApiKey }, async (req, reply) => {
    const { model, varReq } = await parseVariationMultipart(req);
    const started = Date.now();
    try {
      const body = await finishSync(ctx, req, reply, model, "variation", varReq);
      await recordGeneration(ctx, req, model, variationRecordMeta(varReq), "ok", Date.now() - started, null, await extractHistoryImages(ctx, body as Record<string, unknown>));
      return body;
    } catch (err) {
      await recordGeneration(ctx, req, model, variationRecordMeta(varReq), "error", Date.now() - started, err instanceof Error ? err.message : String(err), []);
      throw err;
    }
  });
}

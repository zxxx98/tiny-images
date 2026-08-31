import type { FastifyRequest } from "fastify";
import { ValidationError } from "../core/errors.js";
import type { IncomingImage, UnifiedEditRequest } from "../core/types.js";
import type { AppContext } from "../app.js";
import { extractHistoryImages, fileBaseUrlFor, finishSync, recordGeneration } from "./generations.js";
import { streamImageFlow } from "./stream.js";
import { requireString, validateCommonFields } from "./validate.js";

export interface ParsedEditRequest {
  model: string;
  editReq: UnifiedEditRequest;
  stream: boolean;
}

export async function parseEditMultipart(req: FastifyRequest): Promise<ParsedEditRequest> {
  if (!req.isMultipart()) {
    throw new ValidationError("request must be multipart/form-data");
  }
  const fields: Record<string, unknown> = {};
  const images: IncomingImage[] = [];
  let mask: IncomingImage | undefined;
  for await (const part of req.parts()) {
    if (part.type === "file") {
      const image: IncomingImage = {
        filename: part.filename || "image.png",
        data: await part.toBuffer(),
        mimeType: part.mimetype || "image/png",
      };
      if (part.fieldname === "image") images.push(image);
      else if (part.fieldname === "mask") mask = image;
      // 其他字段名的文件忽略
    } else {
      fields[part.fieldname] = part.value;
    }
  }
  if (images.length === 0) throw new ValidationError("'image' file is required");

  const model = requireString(fields, "model");
  const prompt = requireString(fields, "prompt");
  const common = validateCommonFields(fields);
  return {
    model,
    stream: common.stream,
    editReq: {
      prompt,
      n: common.n,
      size: common.size,
      responseFormat: common.responseFormat,
      images,
      mask,
      passthrough: common.passthrough,
      ...(common.horde ? { providerOptions: { horde: common.horde } } : {}),
    },
  };
}

export function registerEdits(ctx: AppContext): void {
  ctx.app.post("/v1/images/edits", { preHandler: ctx.requireApiKey }, async (req, reply) => {
    const { model, editReq, stream } = await parseEditMultipart(req);
    const started = Date.now();
    if (stream) {
      return streamImageFlow(ctx, req, reply, model, "edit", editReq, fileBaseUrlFor(ctx, req));
    }
    try {
      const body = await finishSync(ctx, req, reply, model, "edit", editReq);
      await recordGeneration(ctx, req, model, editReq, "ok", Date.now() - started, null, await extractHistoryImages(ctx, body as Record<string, unknown>));
      return body;
    } catch (err) {
      await recordGeneration(ctx, req, model, editReq, "error", Date.now() - started, err instanceof Error ? err.message : String(err), []);
      throw err;
    }
  });
}

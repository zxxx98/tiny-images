import type { FastifyRequest } from "fastify";
import { ValidationError } from "../core/errors.js";
import type { IncomingImage, UnifiedEditRequest } from "../core/types.js";
import type { AppContext } from "../app.js";
import { finishSync, requestSignal } from "./generations.js";
import { requireString, validateCommonFields } from "./validate.js";

export function registerEdits(ctx: AppContext): void {
  ctx.app.post("/v1/images/edits", { preHandler: ctx.requireApiKey }, async (req, reply) => {
    if (!req.isMultipart()) {
      throw new ValidationError("request must be multipart/form-data");
    }
    const fields: Record<string, unknown> = {};
    const images: IncomingImage[] = [];
    let mask: IncomingImage | undefined;
    for await (const part of req.parts()) {
      if (part.type === "file") {
        const img: IncomingImage = {
          filename: part.filename || "image.png",
          data: await part.toBuffer(),
          mimeType: part.mimetype || "image/png",
        };
        if (part.fieldname === "image") images.push(img);
        else if (part.fieldname === "mask") mask = img;
        // 其他字段名的文件忽略
      } else {
        fields[part.fieldname] = part.value;
      }
    }
    if (images.length === 0) throw new ValidationError("'image' file is required");

    const model = requireString(fields, "model");
    const prompt = requireString(fields, "prompt");
    const common = validateCommonFields(fields);
    const editReq: UnifiedEditRequest = {
      prompt,
      n: common.n,
      size: common.size,
      responseFormat: common.responseFormat,
      images,
      mask,
      passthrough: common.passthrough,
    };
    void common.stream; // 流式在 Task 12 接入
    return finishSync(ctx, req, reply, model, "edit", editReq);
  });
}

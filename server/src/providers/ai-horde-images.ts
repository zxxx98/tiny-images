import sharp from "sharp";
import { ValidationError } from "../core/errors.js";
import type { IncomingImage } from "../core/types.js";

const MAX_INPUT_PIXELS = 40_000_000;
const SUPPORTED_MIME_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);

export interface HordeWebPImage {
  base64: string;
  width: number;
  height: number;
}

export function assertPixelLimit(width: number, height: number): void {
  if (width * height > MAX_INPUT_PIXELS) {
    throw new ValidationError("image exceeds 40000000 pixels");
  }
}

export async function toHordeWebP(image: IncomingImage, signal: AbortSignal): Promise<HordeWebPImage> {
  if (signal.aborted) throw signal.reason;
  if (!SUPPORTED_MIME_TYPES.has(image.mimeType.toLowerCase())) {
    throw new ValidationError(`unsupported image type '${image.mimeType}'`);
  }
  try {
    const pipeline = sharp(image.data, { limitInputPixels: MAX_INPUT_PIXELS, failOn: "error" });
    const metadata = await pipeline.metadata();
    if (!metadata.width || !metadata.height) throw new ValidationError("image dimensions are unavailable");
    assertPixelLimit(metadata.width, metadata.height);
    const data = await pipeline.webp().toBuffer();
    if (signal.aborted) throw signal.reason;
    return { base64: data.toString("base64"), width: metadata.width, height: metadata.height };
  } catch (error) {
    if (signal.aborted) throw signal.reason;
    if (error instanceof ValidationError) throw error;
    throw new ValidationError(`invalid image '${image.filename}'`);
  }
}

"use strict";

const MAX_WORKER_PIXELS = 32_000_000;
const MAX_WORKER_DIMENSION = 8192;
const OUTPUT_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);

function boundedLimit(value, fallback, maximum) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.min(maximum, Math.floor(number)) : fallback;
}

function fitDimensions(width, height, pixelLimit, dimensionLimit) {
  let targetWidth = Math.max(1, Math.floor(width));
  let targetHeight = Math.max(1, Math.floor(height));
  const scaleByPixels = Math.sqrt(pixelLimit / (targetWidth * targetHeight));
  const scaleByDimension = Math.min(dimensionLimit / targetWidth, dimensionLimit / targetHeight, 1);
  const scale = Math.min(scaleByPixels < 1 ? scaleByPixels : 1, scaleByDimension);
  if (scale < 1) {
    targetWidth = Math.max(1, Math.floor(targetWidth * scale));
    targetHeight = Math.max(1, Math.floor(targetHeight * scale));
  }
  return { width: targetWidth, height: targetHeight, scaled: scale < 0.9999 };
}

self.addEventListener("message", async (event) => {
  const data = event.data || {};
  let bitmap = null;
  try {
    if (typeof OffscreenCanvas === "undefined" || typeof createImageBitmap !== "function") throw new Error("worker unavailable");
    bitmap = await createImageBitmap(data.file, { imageOrientation: "from-image" });
    if (!OUTPUT_TYPES.has(data.outputType)) throw new Error("output format unavailable");
    const maxPixels = boundedLimit(data.maxPixels, 12_000_000, MAX_WORKER_PIXELS);
    const maxDimension = boundedLimit(data.maxDimension, MAX_WORKER_DIMENSION, MAX_WORKER_DIMENSION);
    const target = fitDimensions(bitmap.width, bitmap.height, maxPixels, maxDimension);
    if (!data.allowScale && target.scaled) throw new Error("image exceeds processing limit");
    const canvas = new OffscreenCanvas(target.width, target.height);
    const context = canvas.getContext("2d", { alpha: !data.fillWhite });
    if (!context) throw new Error("canvas unavailable");
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = "high";
    if (data.fillWhite) {
      context.fillStyle = "#ffffff";
      context.fillRect(0, 0, target.width, target.height);
    }
    context.drawImage(bitmap, 0, 0, target.width, target.height);
    const qualityValue = Number(data.quality);
    const quality = Number.isFinite(qualityValue) ? Math.min(1, Math.max(0, qualityValue)) : 0.92;
    const blob = await canvas.convertToBlob({ type: data.outputType, quality });
    if (!blob || blob.type !== data.outputType) throw new Error("output format unavailable");
    self.postMessage({ id: data.id, ok: true, blob, width: target.width, height: target.height, scaled: target.scaled });
  } catch (error) {
    self.postMessage({ id: data.id, ok: false, code: "WORKER_ERROR", error: String(error?.message || error || "処理できませんでした") });
  } finally {
    if (bitmap) bitmap.close();
  }
});

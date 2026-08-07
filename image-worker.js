"use strict";

importScripts("metadata.js?v=2.2.1");

const MAX_WORKER_PIXELS = 32_000_000;
const MAX_WORKER_DIMENSION = 8192;
const MAX_WORKER_FRAMES = 120;
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

function dimensionsMatchHeader(bitmap, header) {
  if (bitmap.width === header.width && bitmap.height === header.height) return true;
  return [5, 6, 7, 8].includes(Number(header.orientation)) && bitmap.width === header.height && bitmap.height === header.width;
}

function describeSafetyFailure(code) {
  const messages = {
    STRUCTURE_ISSUE: "画像の構造に不整合があります",
    SCAN_INCOMPLETE: "画像の構造を最後まで確認できません",
    DIMENSIONS_UNKNOWN: "画像の大きさを確認できません",
    DIMENSION_LIMIT: "画像の縦横が安全上限を超えています",
    PIXEL_LIMIT: "画像の総画素数が安全上限を超えています",
    FRAME_LIMIT: "アニメーションのフレーム数が安全上限を超えています",
    TOTAL_PIXEL_LIMIT: "アニメーションの総画素数が安全上限を超えています"
  };
  return messages[code] || "復号前の画像検査に失敗しました";
}

async function inspectInput(file, maxPixels, maxDimension, maxFrames, maxTotalPixels) {
  if (!file || typeof file.size !== "number") throw new Error("画像ファイルを確認できません");
  const detected = await self.ImageMetadata.detectFile(file);
  if (!detected) throw new Error("対応画像として確認できません");
  const report = await self.ImageMetadata.inspectFile(file, detected.key);
  const safety = self.ImageMetadata.validateDecodeSafety(report, { maxPixels, maxDimension, maxFrames, maxTotalPixels });
  if (!safety.ok) throw new Error(describeSafetyFailure(safety.code));
  return { ...safety, orientation: Number(report.orientation) || 1 };
}

self.addEventListener("message", async (event) => {
  const data = event.data || {};
  let bitmap = null;
  let canvas = null;
  try {
    if (typeof OffscreenCanvas === "undefined" || typeof createImageBitmap !== "function") throw new Error("worker unavailable");
    if (!OUTPUT_TYPES.has(data.outputType)) throw new Error("output format unavailable");
    const maxPixels = boundedLimit(data.maxPixels, 12_000_000, MAX_WORKER_PIXELS);
    const maxDimension = boundedLimit(data.maxDimension, MAX_WORKER_DIMENSION, MAX_WORKER_DIMENSION);
    const maxDecodePixels = boundedLimit(data.maxDecodePixels, maxPixels, MAX_WORKER_PIXELS);
    const maxFrames = boundedLimit(data.maxFrames, MAX_WORKER_FRAMES, MAX_WORKER_FRAMES);
    const maxTotalPixels = boundedLimit(data.maxTotalPixels, maxDecodePixels, MAX_WORKER_PIXELS);
    const header = await inspectInput(data.file, maxDecodePixels, maxDimension, maxFrames, maxTotalPixels);
    bitmap = await createImageBitmap(data.file, { imageOrientation: "from-image" });
    if (!dimensionsMatchHeader(bitmap, header)) throw new Error("復号後の画像サイズがヘッダーと一致しません");
    const target = fitDimensions(bitmap.width, bitmap.height, maxPixels, maxDimension);
    if (!data.allowScale && target.scaled) throw new Error("image exceeds processing limit");
    canvas = new OffscreenCanvas(target.width, target.height);
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
    if (canvas) {
      canvas.width = 1;
      canvas.height = 1;
    }
  }
});

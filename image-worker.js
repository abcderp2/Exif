"use strict";

function fitDimensions(width, height, pixelLimit) {
  const maxDimension = 16384;
  let targetWidth = Math.max(1, Math.floor(width));
  let targetHeight = Math.max(1, Math.floor(height));
  const scaleByPixels = Math.sqrt(pixelLimit / (targetWidth * targetHeight));
  const scaleByDimension = Math.min(maxDimension / targetWidth, maxDimension / targetHeight, 1);
  const scale = Math.min(scaleByPixels < 1 ? scaleByPixels : 1, scaleByDimension);
  if (scale < 1) {
    targetWidth = Math.max(1, Math.floor(targetWidth * scale));
    targetHeight = Math.max(1, Math.floor(targetHeight * scale));
  }
  return { width: targetWidth, height: targetHeight, scaled: scale < 0.9999 };
}

self.addEventListener("message", async (event) => {
  const data = event.data || {};
  try {
    if (typeof OffscreenCanvas === "undefined" || typeof createImageBitmap !== "function") {
      throw new Error("worker unavailable");
    }

    const options = { imageOrientation: "from-image" };
    if (data.resizeWidth && data.resizeHeight) {
      options.resizeWidth = data.resizeWidth;
      options.resizeHeight = data.resizeHeight;
      options.resizeQuality = "high";
    }
    const bitmap = await createImageBitmap(data.file, options);
    const target = fitDimensions(bitmap.width, bitmap.height, data.maxPixels || 24000000);
    const canvas = new OffscreenCanvas(target.width, target.height);
    const context = canvas.getContext("2d", { alpha: data.outputType !== "image/jpeg" });
    if (!context) throw new Error("canvas unavailable");
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = "high";
    if (data.fillWhite) {
      context.fillStyle = "#ffffff";
      context.fillRect(0, 0, target.width, target.height);
    }
    context.drawImage(bitmap, 0, 0, target.width, target.height);
    const blob = await canvas.convertToBlob({ type: data.outputType, quality: data.quality });
    bitmap.close();
    self.postMessage({ id: data.id, ok: true, blob, width: target.width, height: target.height, scaled: target.scaled });
  } catch (error) {
    self.postMessage({ id: data.id, ok: false, code: "WORKER_ERROR", error: String(error?.message || error || "処理できませんでした") });
  }
});

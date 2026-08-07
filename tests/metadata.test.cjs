"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const Metadata = require("../metadata.js");

function be32(value) {
  return Uint8Array.from([(value >>> 24) & 255, (value >>> 16) & 255, (value >>> 8) & 255, value & 255]);
}

function le32(value) {
  return Uint8Array.from([value & 255, (value >>> 8) & 255, (value >>> 16) & 255, (value >>> 24) & 255]);
}

function concat(...parts) {
  const length = parts.reduce((sum, part) => sum + part.length, 0);
  const result = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}

function text(value) {
  return Uint8Array.from(Buffer.from(value, "binary"));
}

function pngChunk(type, payload) {
  return concat(be32(payload.length), text(type), payload, new Uint8Array(4));
}

function makePng() {
  const ihdr = new Uint8Array(13);
  ihdr.set(be32(640), 0);
  ihdr.set(be32(480), 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return concat(
    Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", ihdr),
    pngChunk("tEXt", text("Comment\0private note")),
    pngChunk("IEND", new Uint8Array())
  );
}

function makeJpegWithGps() {
  const tiff = new Uint8Array(32);
  const view = new DataView(tiff.buffer);
  tiff[0] = 0x49;
  tiff[1] = 0x49;
  view.setUint16(2, 42, true);
  view.setUint32(4, 8, true);
  view.setUint16(8, 1, true);
  view.setUint16(10, 0x8825, true);
  view.setUint16(12, 4, true);
  view.setUint32(14, 1, true);
  view.setUint32(18, 26, true);
  view.setUint32(22, 0, true);
  view.setUint16(26, 0, true);
  view.setUint32(28, 0, true);
  const exif = concat(text("Exif\0\0"), tiff);
  const appLength = exif.length + 2;
  const app1 = concat(Uint8Array.from([0xff, 0xe1, (appLength >>> 8) & 255, appLength & 255]), exif);
  const sof = Uint8Array.from([0xff, 0xc0, 0x00, 0x11, 0x08, 0x01, 0xe0, 0x02, 0x80, 0x03, 0x01, 0x11, 0x00, 0x02, 0x11, 0x00, 0x03, 0x11, 0x00]);
  const sos = Uint8Array.from([0xff, 0xda, 0x00, 0x08, 0x01, 0x01, 0x00, 0x00, 0x3f, 0x00]);
  return concat(Uint8Array.from([0xff, 0xd8]), app1, sof, sos, Uint8Array.from([0x00, 0xff, 0xd9]));
}

function webpChunk(type, payload) {
  const padding = payload.length % 2 ? new Uint8Array(1) : new Uint8Array();
  return concat(text(type), le32(payload.length), payload, padding);
}

function makeWebp() {
  const vp8x = new Uint8Array(10);
  vp8x[0] = 0x10;
  const widthMinusOne = 319;
  const heightMinusOne = 239;
  vp8x[4] = widthMinusOne & 255;
  vp8x[5] = (widthMinusOne >>> 8) & 255;
  vp8x[6] = (widthMinusOne >>> 16) & 255;
  vp8x[7] = heightMinusOne & 255;
  vp8x[8] = (heightMinusOne >>> 8) & 255;
  vp8x[9] = (heightMinusOne >>> 16) & 255;
  const body = concat(text("WEBP"), webpChunk("VP8X", vp8x), webpChunk("XMP ", text("x")));
  return concat(text("RIFF"), le32(body.length), body);
}

test("detectFile uses file signatures and reports extension mismatch", async () => {
  const file = new File([makePng()], "photo.jpg", { type: "image/jpeg" });
  const detected = await Metadata.detectFile(file);
  assert.equal(detected.key, "png");
  assert.equal(detected.extensionMismatch, true);
  assert.equal(detected.declaredTypeMismatch, true);
});

test("PNG analysis finds dimensions, alpha, and text metadata", async () => {
  const file = new File([makePng()], "photo.png", { type: "image/png" });
  const report = await Metadata.inspectFile(file, "png");
  assert.equal(report.width, 640);
  assert.equal(report.height, 480);
  assert.equal(report.alpha, true);
  assert.equal(report.sensitive, true);
  assert.ok(report.entries.some((entry) => entry.key === "text"));
  assert.deepEqual(report.structureIssues, []);
});

test("JPEG analysis finds dimensions and GPS metadata", async () => {
  const file = new File([makeJpegWithGps()], "photo.jpg", { type: "image/jpeg" });
  const report = await Metadata.inspectFile(file, "jpeg");
  assert.equal(report.width, 640);
  assert.equal(report.height, 480);
  assert.equal(report.sensitive, true);
  assert.equal(report.exifDetected, true);
  assert.ok(report.entries.some((entry) => entry.key === "gps"));
});

test("WebP analysis finds canvas size, alpha, and XMP", async () => {
  const file = new File([makeWebp()], "photo.webp", { type: "image/webp" });
  const report = await Metadata.inspectFile(file, "webp");
  assert.equal(report.width, 320);
  assert.equal(report.height, 240);
  assert.equal(report.alpha, true);
  assert.ok(report.entries.some((entry) => entry.key === "xmp"));
});

test("pre-decode safety rejects incomplete, oversized, and animated inputs", () => {
  const limits = { maxPixels: 12_000_000, maxDimension: 8192, maxFrames: 120, maxTotalPixels: 12_000_000 };
  const safe = Metadata.validateDecodeSafety({ width: 4000, height: 2000, animated: false, frameCount: 1, structureIssues: [], scanComplete: true }, limits);
  assert.equal(safe.ok, true);

  const incomplete = Metadata.validateDecodeSafety({ width: 4000, height: 2000, animated: false, frameCount: 1, structureIssues: [], scanComplete: false }, limits);
  assert.deepEqual(incomplete, { ok: false, code: "SCAN_INCOMPLETE" });

  const oversized = Metadata.validateDecodeSafety({ width: 5000, height: 5000, animated: false, frameCount: 1, structureIssues: [], scanComplete: true }, limits);
  assert.deepEqual(oversized, { ok: false, code: "PIXEL_LIMIT" });

  const animated = Metadata.validateDecodeSafety({ width: 2000, height: 1000, animated: true, frameCount: 7, structureIssues: [], scanComplete: true }, limits);
  assert.deepEqual(animated, { ok: false, code: "TOTAL_PIXEL_LIMIT" });
});

test("safe report contains categories but no raw metadata values", async () => {
  const file = new File([makePng()], "photo.png", { type: "image/png" });
  const report = await Metadata.inspectFile(file, "png");
  const safe = Metadata.toSafeObject(file, report);
  const serialized = JSON.stringify(safe);
  assert.match(serialized, /説明とコメント/);
  assert.doesNotMatch(serialized, /private note/);
});

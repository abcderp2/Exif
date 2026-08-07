(function (root, factory) {
  "use strict";
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  root.ImageMetadata = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const JPEG_SCAN_LIMIT = 8 * 1024 * 1024;
  const METADATA_PAYLOAD_LIMIT = 1024 * 1024;
  const MAX_CHUNKS = 4096;

  const FORMAT_INFO = {
    jpeg: { label: "JPEG", mime: "image/jpeg", extensions: ["jpg", "jpeg", "jpe"] },
    png: { label: "PNG", mime: "image/png", extensions: ["png"] },
    webp: { label: "WebP", mime: "image/webp", extensions: ["webp"] }
  };

  function getExtension(name) {
    const match = String(name || "").toLowerCase().match(/\.([a-z0-9]+)$/);
    return match ? match[1] : "";
  }

  function ascii(bytes) {
    let result = "";
    for (const byte of bytes) result += String.fromCharCode(byte);
    return result;
  }

  function decodeText(bytes) {
    try {
      return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
    } catch (error) {
      return ascii(bytes);
    }
  }

  async function readBytes(blob, start, length) {
    const safeStart = Math.max(0, Math.min(Number(start) || 0, blob.size));
    const safeLength = Math.max(0, Math.min(Number(length) || 0, blob.size - safeStart));
    return new Uint8Array(await blob.slice(safeStart, safeStart + safeLength).arrayBuffer());
  }

  function detectBufferFormat(bytes) {
    if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "jpeg";
    if (
      bytes.length >= 8 &&
      bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 &&
      bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a
    ) return "png";
    if (bytes.length >= 12 && ascii(bytes.subarray(0, 4)) === "RIFF" && ascii(bytes.subarray(8, 12)) === "WEBP") return "webp";
    return null;
  }

  async function detectFile(file) {
    const header = await readBytes(file, 0, 32);
    const key = detectBufferFormat(header);
    if (!key) return null;
    const info = FORMAT_INFO[key];
    const extension = getExtension(file.name);
    const declaredType = String(file.type || "").toLowerCase();
    return {
      key,
      label: info.label,
      mime: info.mime,
      extension,
      extensionMismatch: Boolean(extension && !info.extensions.includes(extension)),
      declaredTypeMismatch: Boolean(declaredType && declaredType !== info.mime)
    };
  }

  function createReport(formatKey, size) {
    return {
      formatKey,
      formatLabel: FORMAT_INFO[formatKey]?.label || "画像",
      size,
      width: null,
      height: null,
      orientation: 1,
      alpha: false,
      animated: false,
      frameCount: 1,
      exifDetected: false,
      entries: [],
      sensitive: false,
      structureIssues: [],
      warnings: [],
      scannedBytes: 0,
      scanComplete: true
    };
  }

  function addEntry(report, key, label, sensitive, detail) {
    const existing = report.entries.find((entry) => entry.key === key);
    if (existing) {
      existing.count += 1;
      return;
    }
    report.entries.push({ key, label, sensitive: Boolean(sensitive), detail: detail || "", count: 1 });
    if (sensitive) report.sensitive = true;
  }

  function addIssue(report, message) {
    if (!report.structureIssues.includes(message)) report.structureIssues.push(message);
  }

  function addWarning(report, message) {
    if (!report.warnings.includes(message)) report.warnings.push(message);
  }

  function isJpegFrameMarker(marker) {
    return marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker);
  }

  function inspectJpegBytes(bytes, report, completeHeader) {
    if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) {
      addIssue(report, "JPEGの開始位置を確認できませんでした");
      return;
    }
    let offset = 2;
    let reachedImageData = false;
    let segmentCount = 0;

    while (offset + 1 < bytes.length && segmentCount < MAX_CHUNKS) {
      if (bytes[offset] !== 0xff) {
        offset += 1;
        continue;
      }
      while (offset < bytes.length && bytes[offset] === 0xff) offset += 1;
      if (offset >= bytes.length) break;
      const marker = bytes[offset++];
      if (marker === 0xd9) break;
      if (marker === 0xda) {
        reachedImageData = true;
        break;
      }
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
      if (offset + 2 > bytes.length) break;
      const length = (bytes[offset] << 8) | bytes[offset + 1];
      if (length < 2) {
        addIssue(report, "JPEG内に不正な区切り長があります");
        break;
      }
      const dataStart = offset + 2;
      const dataEnd = offset + length;
      if (dataEnd > bytes.length) {
        if (completeHeader) addIssue(report, "JPEGの付加情報が途中で終わっています");
        else {
          report.scanComplete = false;
          addWarning(report, "JPEGの先頭領域が大きいため一部を省略して確認しました");
        }
        break;
      }

      if (isJpegFrameMarker(marker) && dataStart + 5 < dataEnd) {
        report.height = (bytes[dataStart + 1] << 8) | bytes[dataStart + 2];
        report.width = (bytes[dataStart + 3] << 8) | bytes[dataStart + 4];
      } else if (marker === 0xe0) {
        addEntry(report, "jfif", "標準表示情報", false, "JFIF");
      } else if (marker === 0xe1) {
        const payload = bytes.subarray(dataStart, dataEnd);
        const prefix = ascii(payload.subarray(0, Math.min(payload.length, 128)));
        if (prefix.startsWith("Exif\u0000\u0000")) {
          report.exifDetected = true;
          const tiff = parseTiff(payload.subarray(6));
          applyTiffReport(tiff, report);
        } else if (/xmp|adobe/i.test(prefix) || decodeText(payload.subarray(0, Math.min(payload.length, 1024))).includes("<x:xmpmeta")) {
          addEntry(report, "xmp", "XMP情報", true, "編集履歴や説明を含む場合があります");
        } else {
          addEntry(report, "app1", "アプリ固有情報", true, "APP1");
        }
      } else if (marker === 0xed) {
        addEntry(report, "iptc", "IPTC情報", true, "説明や作者情報を含む場合があります");
      } else if (marker === 0xfe) {
        addEntry(report, "comment", "コメント", true, "JPEGコメント");
      } else if (marker === 0xe2) {
        const prefix = ascii(bytes.subarray(dataStart, Math.min(dataEnd, dataStart + 32)));
        if (prefix.startsWith("ICC_PROFILE")) addEntry(report, "icc", "色設定", false, "ICCプロファイル");
        else addEntry(report, "app2", "アプリ固有情報", true, "APP2");
      } else if (marker >= 0xe3 && marker <= 0xef) {
        addEntry(report, `app${marker - 0xe0}`, "アプリ固有情報", true, `APP${marker - 0xe0}`);
      }
      offset = dataEnd;
      segmentCount += 1;
    }

    if (segmentCount >= MAX_CHUNKS) {
      report.scanComplete = false;
      addWarning(report, "JPEGの区切り数が多いため確認を打ち切りました");
    }
    if (!reachedImageData && !completeHeader) report.scanComplete = false;
  }

  async function inspectJpeg(file, report) {
    const length = Math.min(file.size, JPEG_SCAN_LIMIT);
    const bytes = await readBytes(file, 0, length);
    report.scannedBytes = bytes.length;
    inspectJpegBytes(bytes, report, length === file.size);
  }

  async function inspectPng(file, report) {
    const first = await readBytes(file, 0, Math.min(file.size, 33));
    report.scannedBytes += first.length;
    if (first.length < 33 || detectBufferFormat(first) !== "png") {
      addIssue(report, "PNGの基本構造を確認できませんでした");
      return;
    }
    if (readUint32BE(first, 8) !== 13 || ascii(first.subarray(12, 16)) !== "IHDR") {
      addIssue(report, "PNGの先頭区切りを確認できませんでした");
      return;
    }
    report.width = readUint32BE(first, 16);
    report.height = readUint32BE(first, 20);
    const colorType = first[25];
    report.alpha = colorType === 4 || colorType === 6;

    let offset = 8;
    let chunks = 0;
    let sawEnd = false;
    while (offset + 12 <= file.size && chunks < MAX_CHUNKS) {
      const header = await readBytes(file, offset, 12);
      report.scannedBytes += header.length;
      if (header.length < 12) {
        addIssue(report, "PNGの区切りが途中で終わっています");
        break;
      }
      const length = readUint32BE(header, 0);
      const type = ascii(header.subarray(4, 8));
      const dataStart = offset + 8;
      const next = dataStart + length + 4;
      if (!/^[A-Za-z]{4}$/.test(type) || next > file.size) {
        addIssue(report, "PNG内に不正な区切りがあります");
        break;
      }

      if (type === "eXIf") {
        report.exifDetected = true;
        const payload = await readBytes(file, dataStart, Math.min(length, METADATA_PAYLOAD_LIMIT));
        report.scannedBytes += payload.length;
        applyTiffReport(parseTiff(payload), report);
        if (length > payload.length) {
          report.scanComplete = false;
          addWarning(report, "大きなExif領域の一部を省略して確認しました");
        }
      } else if (["tEXt", "zTXt", "iTXt"].includes(type)) {
        const sample = await readBytes(file, dataStart, Math.min(length, 512));
        report.scannedBytes += sample.length;
        const text = decodeText(sample).toLowerCase();
        if (text.includes("xmp") || text.includes("xml:com.adobe.xmp")) addEntry(report, "xmp", "XMP情報", true, "PNGテキスト領域");
        else addEntry(report, "text", "説明とコメント", true, "PNGテキスト領域");
      } else if (type === "tIME") {
        addEntry(report, "time", "更新日時", true, "PNG tIME");
      } else if (type === "iCCP") {
        addEntry(report, "icc", "色設定", false, "ICCプロファイル");
      } else if (["sRGB", "cHRM", "gAMA"].includes(type)) {
        addEntry(report, "color", "色設定", false, type);
      } else if (type === "pHYs") {
        addEntry(report, "resolution", "解像度設定", false, "PNG pHYs");
      } else if (type === "acTL") {
        report.animated = true;
        const payload = await readBytes(file, dataStart, Math.min(length, 8));
        report.scannedBytes += payload.length;
        const frameCount = readUint32BE(payload, 0);
        if (payload.length < 8 || frameCount < 1) addIssue(report, "PNGアニメーションのフレーム数を確認できませんでした");
        else report.frameCount = frameCount;
      } else if (type === "IEND") {
        sawEnd = true;
      } else if (type[0] === type[0].toLowerCase() && !["IDAT"].includes(type)) {
        addEntry(report, `png-${type}`, "補助情報", true, type);
      }

      offset = next;
      chunks += 1;
      if (type === "IEND") break;
    }
    if (!sawEnd) addIssue(report, "PNGの終端を確認できませんでした");
    if (chunks >= MAX_CHUNKS) {
      report.scanComplete = false;
      addWarning(report, "PNGの区切り数が多いため確認を打ち切りました");
    }
  }

  async function inspectWebp(file, report) {
    const first = await readBytes(file, 0, Math.min(file.size, 32));
    report.scannedBytes += first.length;
    if (first.length < 16 || detectBufferFormat(first) !== "webp") {
      addIssue(report, "WebPの基本構造を確認できませんでした");
      return;
    }
    const riffSize = readUint32LE(first, 4) + 8;
    if (riffSize > file.size) addIssue(report, "WebPの記録サイズが実際のファイルを超えています");
    if (riffSize < file.size) addWarning(report, "WebP末尾に追加データがある可能性があります");

    let offset = 12;
    let chunks = 0;
    let animationFrames = 0;
    while (offset + 8 <= file.size && chunks < MAX_CHUNKS) {
      const header = await readBytes(file, offset, 8);
      report.scannedBytes += header.length;
      if (header.length < 8) break;
      const type = ascii(header.subarray(0, 4));
      const length = readUint32LE(header, 4);
      const dataStart = offset + 8;
      const dataEnd = dataStart + length;
      const next = dataEnd + (length % 2);
      if (dataEnd > file.size) {
        addIssue(report, "WebP内の区切りが途中で終わっています");
        break;
      }

      if (type === "VP8X") {
        const payload = await readBytes(file, dataStart, Math.min(length, 10));
        report.scannedBytes += payload.length;
        if (payload.length >= 10) {
          const flags = payload[0];
          report.alpha = Boolean(flags & 0x10);
          report.animated = Boolean(flags & 0x02);
          report.width = 1 + readUint24LE(payload, 4);
          report.height = 1 + readUint24LE(payload, 7);
        }
      } else if (type === "VP8 ") {
        const payload = await readBytes(file, dataStart, Math.min(length, 10));
        report.scannedBytes += payload.length;
        if (payload.length >= 10 && payload[3] === 0x9d && payload[4] === 0x01 && payload[5] === 0x2a) {
          report.width = readUint16LE(payload, 6) & 0x3fff;
          report.height = readUint16LE(payload, 8) & 0x3fff;
        }
      } else if (type === "VP8L") {
        const payload = await readBytes(file, dataStart, Math.min(length, 5));
        report.scannedBytes += payload.length;
        if (payload.length >= 5 && payload[0] === 0x2f) {
          report.width = 1 + ((payload[1] | (payload[2] << 8)) & 0x3fff);
          report.height = 1 + (((payload[2] >> 6) | (payload[3] << 2) | (payload[4] << 10)) & 0x3fff);
          report.alpha = true;
        }
      } else if (type === "EXIF") {
        report.exifDetected = true;
        const payload = await readBytes(file, dataStart, Math.min(length, METADATA_PAYLOAD_LIMIT));
        report.scannedBytes += payload.length;
        const start = payload.length >= 6 && ascii(payload.subarray(0, 6)) === "Exif\u0000\u0000" ? 6 : 0;
        applyTiffReport(parseTiff(payload.subarray(start)), report);
        if (length > payload.length) {
          report.scanComplete = false;
          addWarning(report, "大きなExif領域の一部を省略して確認しました");
        }
      } else if (type === "XMP ") {
        addEntry(report, "xmp", "XMP情報", true, "WebP XMP");
      } else if (type === "ICCP") {
        addEntry(report, "icc", "色設定", false, "ICCプロファイル");
      } else if (type === "ANIM") {
        report.animated = true;
      } else if (type === "ANMF") {
        report.animated = true;
        animationFrames += 1;
      } else if (type === "LIST") {
        addEntry(report, "list", "アプリ固有情報", true, "WebP LIST");
      }
      offset = next;
      chunks += 1;
    }
    if (animationFrames) report.frameCount = animationFrames;
    if (chunks >= MAX_CHUNKS) {
      report.scanComplete = false;
      addWarning(report, "WebPの区切り数が多いため確認を打ち切りました");
    }
  }

  function parseTiff(bytes) {
    const result = {
      valid: false,
      tags: new Set(),
      orientation: 1,
      width: null,
      height: null,
      gps: false,
      exif: false,
      thumbnail: false
    };
    if (!bytes || bytes.length < 8) return result;
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const order = view.getUint16(0, false);
    if (order !== 0x4949 && order !== 0x4d4d) return result;
    const little = order === 0x4949;
    const get16 = (offset) => view.getUint16(offset, little);
    const get32 = (offset) => view.getUint32(offset, little);
    if (get16(2) !== 42) return result;
    result.valid = true;
    const visited = new Set();
    const typeSizes = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 6: 1, 7: 1, 8: 2, 9: 4, 10: 8, 11: 4, 12: 8 };

    function readNumber(entry, type, count) {
      const size = typeSizes[type];
      if (!size || count < 1 || count > 100000) return null;
      const total = size * count;
      const pointer = total <= 4 ? entry + 8 : get32(entry + 8);
      if (pointer < 0 || pointer + total > view.byteLength) return null;
      if (type === 3) return get16(pointer);
      if (type === 4 || type === 9) return get32(pointer);
      return null;
    }

    function walk(relativeOffset, depth, kind) {
      if (depth > 6 || visited.has(`${relativeOffset}:${kind}`)) return;
      if (relativeOffset < 0 || relativeOffset + 2 > view.byteLength) return;
      visited.add(`${relativeOffset}:${kind}`);
      const count = get16(relativeOffset);
      if (count > 2048 || relativeOffset + 2 + count * 12 + 4 > view.byteLength) return;
      for (let index = 0; index < count; index += 1) {
        const entry = relativeOffset + 2 + index * 12;
        const tag = get16(entry);
        const type = get16(entry + 2);
        const valueCount = get32(entry + 4);
        const value = readNumber(entry, type, valueCount);
        result.tags.add(tag);
        if (tag === 0x0112 && typeof value === "number" && value >= 1 && value <= 8) result.orientation = value;
        if (tag === 0x0100 && typeof value === "number") result.width = value;
        if (tag === 0x0101 && typeof value === "number") result.height = value;
        if (tag === 0x8769 && typeof value === "number") {
          result.exif = true;
          walk(value, depth + 1, "exif");
        }
        if (tag === 0x8825 && typeof value === "number") {
          result.gps = true;
          walk(value, depth + 1, "gps");
        }
        if ((tag === 0xa005 || tag === 0x014a) && typeof value === "number") walk(value, depth + 1, "linked");
        if (tag === 0x0201 || tag === 0x0202) result.thumbnail = true;
      }
      const nextPointer = relativeOffset + 2 + count * 12;
      if (kind === "ifd0" && nextPointer + 4 <= view.byteLength) {
        const next = get32(nextPointer);
        if (next) walk(next, depth + 1, "ifd1");
      }
    }

    const firstIfd = get32(4);
    walk(firstIfd, 0, "ifd0");
    return result;
  }

  function applyTiffReport(tiff, report) {
    report.exifDetected = true;
    if (!tiff || !tiff.valid) {
      addEntry(report, "exif", "Exif情報", true, "形式を十分に解析できませんでした");
      return;
    }
    if (tiff.width && tiff.height) {
      report.width = report.width || tiff.width;
      report.height = report.height || tiff.height;
    }
    report.orientation = tiff.orientation || report.orientation || 1;
    const tags = tiff.tags;
    if (tiff.gps || tags.has(0x0001) || tags.has(0x0002) || tags.has(0x0003) || tags.has(0x0004)) addEntry(report, "gps", "GPS位置情報", true, "緯度や経度を含む場合があります");
    if ([0x9003, 0x9004, 0x0132, 0x9290, 0x9291, 0x9292].some((tag) => tags.has(tag))) addEntry(report, "datetime", "撮影日時", true, "撮影時刻や更新時刻");
    if ([0x010f, 0x0110, 0x0131].some((tag) => tags.has(tag))) addEntry(report, "device", "機種とソフトウェア", true, "メーカー、機種、編集ソフト");
    if ([0xa431, 0xa432, 0xa433, 0xa434, 0xa435].some((tag) => tags.has(tag))) addEntry(report, "serial", "機器とレンズ識別情報", true, "本体番号やレンズ情報を含む場合があります");
    if ([0x013b, 0x8298].some((tag) => tags.has(tag))) addEntry(report, "author", "作者と著作権", true, "作者名や権利表記");
    if ([0x9286, 0xa420, 0x010e, 0x9c9c, 0x9c9d, 0x9c9e, 0x9c9f].some((tag) => tags.has(tag))) addEntry(report, "comment", "説明とコメント", true, "説明、コメント、Windows XPタグ");
    if (tiff.thumbnail) addEntry(report, "thumbnail", "埋め込みサムネイル", true, "元画像とは別の縮小画像");
    if (tags.size && !report.entries.some((entry) => entry.key === "exif")) addEntry(report, "exif", "Exif付加情報", true, "撮影条件などのタグ");
  }

  async function inspectFile(file, formatKey) {
    const key = formatKey || (await detectFile(file))?.key;
    const report = createReport(key, file.size);
    if (!FORMAT_INFO[key]) {
      addIssue(report, "対応形式として判定できませんでした");
      return report;
    }
    try {
      if (key === "jpeg") await inspectJpeg(file, report);
      else if (key === "png") await inspectPng(file, report);
      else if (key === "webp") await inspectWebp(file, report);
    } catch (error) {
      addIssue(report, "ファイル構造の確認中に読み込みエラーが発生しました");
    }
    return report;
  }

  function positiveSafeInteger(value, fallback) {
    const number = Number(value);
    return Number.isSafeInteger(number) && number > 0 ? number : fallback;
  }

  function validateDecodeSafety(report, options = {}) {
    const maxPixels = positiveSafeInteger(options.maxPixels, 32_000_000);
    const maxDimension = positiveSafeInteger(options.maxDimension, 8192);
    const maxFrames = positiveSafeInteger(options.maxFrames, 120);
    const maxTotalPixels = positiveSafeInteger(options.maxTotalPixels, maxPixels);
    const issues = Array.isArray(report?.structureIssues) ? report.structureIssues : [];
    if (issues.length) return { ok: false, code: "STRUCTURE_ISSUE" };
    if (!report?.scanComplete) return { ok: false, code: "SCAN_INCOMPLETE" };

    const width = Number(report?.width);
    const height = Number(report?.height);
    if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1) {
      return { ok: false, code: "DIMENSIONS_UNKNOWN" };
    }
    if (width > maxDimension || height > maxDimension) return { ok: false, code: "DIMENSION_LIMIT" };

    const pixels = width * height;
    if (!Number.isSafeInteger(pixels) || pixels > maxPixels) return { ok: false, code: "PIXEL_LIMIT" };

    const frameCount = report?.animated ? Number(report?.frameCount) : 1;
    if (!Number.isSafeInteger(frameCount) || frameCount < 1 || frameCount > maxFrames) {
      return { ok: false, code: "FRAME_LIMIT" };
    }
    const totalPixels = pixels * frameCount;
    if (!Number.isSafeInteger(totalPixels) || totalPixels > maxTotalPixels) return { ok: false, code: "TOTAL_PIXEL_LIMIT" };

    return {
      ok: true,
      width,
      height,
      pixels,
      frameCount,
      totalPixels,
      maxPixels,
      maxDimension,
      maxFrames,
      maxTotalPixels
    };
  }

  function summary(report) {
    if (!report) return "分析前です";
    const sensitive = report.entries.filter((entry) => entry.sensitive).map((entry) => entry.label);
    const display = report.entries.filter((entry) => !entry.sensitive).map((entry) => entry.label);
    const exifText = report.exifDetected ? "Exif情報を検出しました。" : "Exif情報は検出されませんでした。";
    if (sensitive.length) return exifText + "個人情報につながる可能性がある領域を検出しました。" + sensitive.slice(0, 5).join("、");
    if (display.length) return exifText + "個人情報領域は見つかりませんでした。表示用の付加情報があります。" + display.slice(0, 4).join("、");
    return exifText + "標準的な付加情報領域は見つかりませんでした";
  }

  function toSafeObject(file, report, options = {}) {
    return {
      schemaVersion: 1,
      file: {
        name: String(options.fileName || file.name || "image"),
        size: file.size,
        declaredType: String(file.type || "")
      },
      analysis: {
        format: report.formatLabel,
        width: report.width,
        height: report.height,
        orientation: report.orientation,
        alpha: report.alpha,
        animated: report.animated,
        frameCount: report.frameCount,
        exifDetected: Boolean(report.exifDetected),
        sensitiveMetadataDetected: report.sensitive,
        metadataAreas: report.entries.map((entry) => ({
          label: entry.label,
          sensitive: entry.sensitive,
          detail: entry.detail,
          count: entry.count
        })),
        structureIssues: report.structureIssues.slice(),
        warnings: report.warnings.slice(),
        scanComplete: report.scanComplete,
        scannedBytes: report.scannedBytes
      }
    };
  }

  function readUint16LE(bytes, offset) {
    return offset + 1 < bytes.length ? bytes[offset] | (bytes[offset + 1] << 8) : 0;
  }

  function readUint24LE(bytes, offset) {
    return offset + 2 < bytes.length ? bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16) : 0;
  }

  function readUint32LE(bytes, offset) {
    return offset + 3 < bytes.length ? (bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16) | (bytes[offset + 3] << 24)) >>> 0 : 0;
  }

  function readUint32BE(bytes, offset) {
    return offset + 3 < bytes.length ? (((bytes[offset] << 24) >>> 0) | (bytes[offset + 1] << 16) | (bytes[offset + 2] << 8) | bytes[offset + 3]) >>> 0 : 0;
  }

  return Object.freeze({
    FORMAT_INFO,
    detectBufferFormat,
    detectFile,
    inspectFile,
    validateDecodeSafety,
    summary,
    toSafeObject
  });
});

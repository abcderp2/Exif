(() => {
  "use strict";

  const MAX_FILE_BYTES = 50 * 1024 * 1024;
  const MAX_TOTAL_BYTES = 150 * 1024 * 1024;
  const MAX_FILES = 50;
  const ANALYSIS_BYTES = 4 * 1024 * 1024;
  const MAX_SAFE_PIXELS = 64 * 1000 * 1000;
  const MAX_CANVAS_DIMENSION = 16384;
  const WORKER_PATH = "image-worker.js";

  const STATUS_LABELS = {
    waiting: "待機中",
    processing: "処理中",
    success: "完了",
    error: "失敗"
  };

  const FORMAT_BY_EXTENSION = {
    jpg: "jpeg",
    jpeg: "jpeg",
    jpe: "jpeg",
    png: "png",
    webp: "webp",
    gif: "gif",
    bmp: "bmp",
    tif: "tiff",
    tiff: "tiff",
    avif: "avif",
    heic: "heic",
    heif: "heif",
    jxl: "jxl",
    ico: "ico",
    svg: "svg"
  };

  const FORMAT_LABELS = {
    jpeg: "JPEG",
    png: "PNG",
    webp: "WebP",
    gif: "GIF",
    bmp: "BMP",
    tiff: "TIFF",
    avif: "AVIF",
    heic: "HEIC",
    heif: "HEIF",
    jxl: "JPEG XL",
    ico: "ICO",
    svg: "SVG",
    browser: "画像"
  };

  const elements = {
    dropZone: document.getElementById("dropZone"),
    fileInput: document.getElementById("fileInput"),
    qualitySelect: document.getElementById("qualitySelect"),
    largeImageSelect: document.getElementById("largeImageSelect"),
    settingsNote: document.getElementById("settings-note"),
    queuePanel: document.getElementById("queuePanel"),
    queueCount: document.getElementById("queueCount"),
    queueStatus: document.getElementById("queueStatus"),
    progressBar: document.getElementById("progressBar"),
    progressPercent: document.getElementById("progressPercent"),
    startButton: document.getElementById("startButton"),
    downloadAllButton: document.getElementById("downloadAllButton"),
    resetButton: document.getElementById("resetButton"),
    resultsPanel: document.getElementById("resultsPanel"),
    resultsList: document.getElementById("resultsList"),
    previewPanel: document.getElementById("previewPanel"),
    previewImage: document.getElementById("previewImage"),
    previewCaption: document.getElementById("previewCaption")
  };

  const state = {
    items: [],
    processing: false,
    runId: 0,
    notice: "",
    previewId: null,
    worker: null,
    workerSequence: 0,
    workerRequests: new Map()
  };

  const devicePixelBudget = detectDevicePixelBudget();

  function detectDevicePixelBudget() {
    const memory = Number(navigator.deviceMemory || 4);
    const cores = Number(navigator.hardwareConcurrency || 4);
    if (memory <= 2 || cores <= 2) return 12 * 1000 * 1000;
    if (memory <= 4 || cores <= 4) return 24 * 1000 * 1000;
    return 36 * 1000 * 1000;
  }

  function init() {
    elements.dropZone.addEventListener("click", () => elements.fileInput.click());
    elements.fileInput.addEventListener("change", () => {
      addFiles(Array.from(elements.fileInput.files || []));
      elements.fileInput.value = "";
    });

    ["dragenter", "dragover"].forEach((eventName) => {
      elements.dropZone.addEventListener(eventName, (event) => {
        event.preventDefault();
        elements.dropZone.classList.add("is-dragover");
      });
    });

    ["dragleave", "dragend", "drop"].forEach((eventName) => {
      elements.dropZone.addEventListener(eventName, (event) => {
        event.preventDefault();
        elements.dropZone.classList.remove("is-dragover");
      });
    });

    elements.dropZone.addEventListener("drop", (event) => {
      addFiles(Array.from(event.dataTransfer.files || []));
    });

    elements.qualitySelect.addEventListener("change", updateSettingsNote);
    elements.largeImageSelect.addEventListener("change", updateSettingsNote);
    elements.startButton.addEventListener("click", processPending);
    elements.downloadAllButton.addEventListener("click", downloadAll);
    elements.resetButton.addEventListener("click", resetAll);
    elements.resultsList.addEventListener("click", handleResultAction);
    window.addEventListener("pagehide", releaseResources);

    updateSettingsNote();
    render();
  }

  function updateSettingsNote() {
    const quality = Math.round(Number(elements.qualitySelect.value) * 100);
    const mode = elements.largeImageSelect.value;
    const pixelText = formatPixels(devicePixelBudget);
    if (mode === "safe") {
      elements.settingsNote.textContent = `JPEGとWebPは再エンコードするため、元と完全に同じ画質にはなりません。PNGは画素を変えずに保存します。大きな画像はこの端末の安全目安 ${pixelText} まで縮小します。`;
    } else {
      elements.settingsNote.textContent = `JPEGとWebPの画質は ${quality} です。元のサイズを優先しますが、端末の上限を超える画像は処理できません。低性能端末では安全設定を推奨します。`;
    }
  }

  async function addFiles(files) {
    if (!files.length) return;
    const currentBytes = state.items.reduce((sum, item) => sum + item.file.size, 0);
    let totalBytes = currentBytes;
    let accepted = 0;
    const rejected = [];

    for (const file of files) {
      if (state.items.length >= MAX_FILES) {
        rejected.push(`${file.name}は個数上限を超えています`);
        continue;
      }
      if (file.size <= 0) {
        rejected.push(`${file.name}は空のファイルです`);
        continue;
      }
      if (file.size > MAX_FILE_BYTES) {
        rejected.push(`${file.name}は1個あたり50MBを超えています`);
        continue;
      }
      if (totalBytes + file.size > MAX_TOTAL_BYTES) {
        rejected.push(`${file.name}を加えると合計150MBを超えます`);
        continue;
      }

      const key = makeFileKey(file);
      if (state.items.some((item) => item.key === key)) {
        rejected.push(`${file.name}はすでに一覧にあります`);
        continue;
      }

      const format = await detectFormat(file);
      if (!format) {
        rejected.push(`${file.name}は画像形式として判定できません`);
        continue;
      }

      state.items.push({
        id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
        key,
        file,
        format,
        status: "waiting",
        metadata: null,
        outputBlob: null,
        outputUrl: "",
        outputName: "",
        outputType: "",
        width: null,
        height: null,
        scaled: false,
        verification: false,
        duration: 0,
        error: "",
        warning: ""
      });
      totalBytes += file.size;
      accepted += 1;
    }

    if (accepted) {
      state.notice = `${accepted}個の画像を待機一覧に追加しました`;
    }
    if (rejected.length) {
      state.notice = rejected.slice(0, 2).join("。 ") + (rejected.length > 2 ? "。ほかにも追加できない画像があります" : "");
    }
    render();
  }

  function makeFileKey(file) {
    return [file.name, file.size, file.lastModified, file.type].join("|");
  }

  async function detectFormat(file) {
    const header = new Uint8Array(await file.slice(0, Math.min(file.size, 512)).arrayBuffer());
    const magic = detectMagicFormat(header);
    if (magic) return { key: magic, label: FORMAT_LABELS[magic] };

    const extension = getExtension(file.name);
    const fromExtension = FORMAT_BY_EXTENSION[extension];
    if (fromExtension) return { key: fromExtension, label: FORMAT_LABELS[fromExtension] };

    const mime = String(file.type || "").toLowerCase();
    if (mime.startsWith("image/")) return { key: "browser", label: mime };
    return null;
  }

  function detectMagicFormat(bytes) {
    if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "jpeg";
    if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 && bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a) return "png";
    if (bytes.length >= 6 && /^GIF8[79]a$/.test(ascii(bytes.slice(0, 6)))) return "gif";
    if (bytes.length >= 12 && ascii(bytes.slice(0, 4)) === "RIFF" && ascii(bytes.slice(8, 12)) === "WEBP") return "webp";
    if (bytes.length >= 2 && bytes[0] === 0x42 && bytes[1] === 0x4d) return "bmp";
    if (bytes.length >= 4 && ((bytes[0] === 0x49 && bytes[1] === 0x49 && bytes[2] === 0x2a && bytes[3] === 0x00) || (bytes[0] === 0x4d && bytes[1] === 0x4d && bytes[2] === 0x00 && bytes[3] === 0x2a))) return "tiff";
    if (bytes.length >= 4 && bytes[0] === 0x00 && bytes[1] === 0x00 && (bytes[2] === 0x01 || bytes[2] === 0x02) && bytes[3] === 0x00) return "ico";
    if (isIsoBmffImage(bytes)) {
      const brand = ascii(bytes.slice(8, 12)).trim();
      if (brand === "avif" || brand === "avis") return "avif";
      if (brand === "heic" || brand === "heix") return "heic";
      if (brand === "heif" || brand === "heis" || brand === "mif1" || brand === "msf1") return "heif";
    }
    const text = decodeText(bytes).replace(/^\uFEFF/, "").trimStart().slice(0, 300).toLowerCase();
    if (text.startsWith("<svg") || text.startsWith("<?xml") && text.includes("<svg")) return "svg";
    return null;
  }

  function isIsoBmffImage(bytes) {
    return bytes.length >= 12 && ascii(bytes.slice(4, 8)) === "ftyp";
  }

  async function processPending() {
    if (state.processing) return;
    const pending = state.items.filter((item) => item.status === "waiting");
    if (!pending.length) {
      state.notice = "待機中の画像がありません";
      render();
      return;
    }

    state.processing = true;
    state.notice = "";
    const runId = ++state.runId;
    render();

    for (const item of pending) {
      if (state.runId !== runId) break;
      await processItem(item, runId);
      if (state.runId !== runId) break;
      render();
      await yieldToBrowser();
    }

    if (state.runId === runId) {
      state.processing = false;
      const success = state.items.filter((item) => item.status === "success").length;
      const errors = state.items.filter((item) => item.status === "error").length;
      state.notice = errors ? `処理が完了しました。成功${success}個、確認が必要な画像${errors}個です` : `処理が完了しました。${success}個の画像を確認できます`;
      render();
    }
  }

  async function processItem(item, runId) {
    item.status = "processing";
    item.error = "";
    item.warning = "";
    releaseItemOutput(item);
    render();
    const started = performance.now();

    try {
      const sourceBuffer = await readAnalysisBuffer(item.file);
      const report = inspectMetadata(sourceBuffer, item.format.key);
      const plan = makeProcessingPlan(report, item.format.key);
      const spec = chooseOutput(item.format.key);
      let encoded;

      if (item.format.key === "svg") {
        encoded = await encodeSvg(item.file, spec, plan);
      } else {
        encoded = await encodeRaster(item.file, item.format.key, spec, report, plan);
      }

      if (state.runId !== runId) return;
      const outputKey = formatKeyFromMime(encoded.blob.type || spec.type);
      const verificationBuffer = await encoded.blob.slice(0, ANALYSIS_BYTES).arrayBuffer();
      const verification = inspectMetadata(verificationBuffer, outputKey);
      const actualSpec = resolveActualOutput(encoded.blob.type, spec);
      item.metadata = report;
      item.outputBlob = encoded.blob;
      item.outputUrl = URL.createObjectURL(encoded.blob);
      item.outputType = encoded.blob.type || actualSpec.type;
      item.outputName = makeOutputName(item.file.name, actualSpec.extension);
      item.width = encoded.width;
      item.height = encoded.height;
      item.scaled = Boolean(encoded.scaled || plan.scaled);
      item.verification = !verification.sensitive;
      item.duration = performance.now() - started;
      item.warning = buildOutputWarning(item.format.key, actualSpec, item.scaled, report);
      item.status = "success";
      if (!state.previewId) state.previewId = item.id;
    } catch (error) {
      if (state.runId !== runId) return;
      item.status = "error";
      item.duration = performance.now() - started;
      item.error = normalizeError(error);
    }
  }

  async function encodeRaster(file, sourceKey, spec, report, plan) {
    const workerResult = await tryWorkerEncode(file, spec, plan);
    if (workerResult) return workerResult;
    return encodeOnMain(file, spec, plan, report.orientation || 1);
  }

  async function tryWorkerEncode(file, spec, plan) {
    if (!window.Worker || !window.OffscreenCanvas || !window.createImageBitmap) return null;
    try {
      return await requestWorker({
        file,
        outputType: spec.type,
        quality: Number(elements.qualitySelect.value),
        maxPixels: getPixelLimit(),
        resizeWidth: plan.resizeWidth,
        resizeHeight: plan.resizeHeight,
        fillWhite: spec.type === "image/jpeg"
      });
    } catch (error) {
      if (error && error.code === "CANCELLED") throw error;
      return null;
    }
  }

  function requestWorker(payload) {
    const worker = getWorker();
    if (!worker) return Promise.reject(new Error("worker unavailable"));
    const id = ++state.workerSequence;
    return new Promise((resolve, reject) => {
      state.workerRequests.set(id, { resolve, reject });
      try {
        worker.postMessage({ id, ...payload });
      } catch (error) {
        state.workerRequests.delete(id);
        reject(error);
      }
    });
  }

  function getWorker() {
    if (state.worker) return state.worker;
    try {
      state.worker = new Worker(new URL(WORKER_PATH, document.baseURI));
      state.worker.addEventListener("message", (event) => {
        const data = event.data || {};
        const request = state.workerRequests.get(data.id);
        if (!request) return;
        state.workerRequests.delete(data.id);
        if (data.ok) request.resolve(data);
        else {
          const error = new Error(data.error || "画像処理に失敗しました");
          error.code = data.code || "WORKER_ERROR";
          request.reject(error);
        }
      });
      state.worker.addEventListener("error", () => {
        rejectWorkerRequests(new Error("画像処理の準備に失敗しました"));
        state.worker.terminate();
        state.worker = null;
      });
      return state.worker;
    } catch (error) {
      state.worker = null;
      return null;
    }
  }

  function rejectWorkerRequests(error) {
    state.workerRequests.forEach((request) => request.reject(error));
    state.workerRequests.clear();
  }

  async function encodeOnMain(file, spec, plan, orientation) {
    let source;
    let sourceUrl = "";
    let orientedByBitmap = false;
    try {
      if (window.createImageBitmap) {
        try {
          const options = { imageOrientation: "from-image" };
          if (plan.resizeWidth && plan.resizeHeight) {
            options.resizeWidth = plan.resizeWidth;
            options.resizeHeight = plan.resizeHeight;
            options.resizeQuality = "high";
          }
          source = await createImageBitmap(file, options);
          orientedByBitmap = true;
        } catch (error) {
          source = null;
        }
      }
      if (!source) {
        sourceUrl = URL.createObjectURL(file);
        source = await loadImage(sourceUrl);
      }

      const sourceWidth = source.naturalWidth || source.width;
      const sourceHeight = source.naturalHeight || source.height;
      const visualWidth = !orientedByBitmap && needsSwappedOrientation(orientation) ? sourceHeight : sourceWidth;
      const visualHeight = !orientedByBitmap && needsSwappedOrientation(orientation) ? sourceWidth : sourceHeight;
      const target = fitDimensions(visualWidth, visualHeight, getPixelLimit());
      const canvas = document.createElement("canvas");
      canvas.width = target.width;
      canvas.height = target.height;
      const context = canvas.getContext("2d", { alpha: spec.type !== "image/jpeg" });
      if (!context) throw new Error("この端末では画像処理用の画面を作れません");
      context.imageSmoothingEnabled = true;
      context.imageSmoothingQuality = "high";
      if (spec.type === "image/jpeg") {
        context.fillStyle = "#ffffff";
        context.fillRect(0, 0, target.width, target.height);
      }

      const scaleX = target.width / visualWidth;
      const scaleY = target.height / visualHeight;
      context.save();
      context.scale(scaleX, scaleY);
      if (!orientedByBitmap) applyOrientation(context, orientation, sourceWidth, sourceHeight);
      context.drawImage(source, 0, 0, sourceWidth, sourceHeight);
      context.restore();

      const blob = await canvasToBlob(canvas, spec.type, Number(elements.qualitySelect.value));
      return { blob, width: target.width, height: target.height, scaled: target.scaled };
    } finally {
      if (sourceUrl) URL.revokeObjectURL(sourceUrl);
      if (source && typeof source.close === "function") source.close();
    }
  }

  async function encodeSvg(file, spec, plan) {
    const safeText = await sanitizeSvg(file);
    const safeBlob = new Blob([safeText], { type: "image/svg+xml" });
    return encodeOnMain(safeBlob, spec, plan, 1);
  }

  async function sanitizeSvg(file) {
    const text = await file.text();
    if (text.length > 5 * 1024 * 1024) throw new Error("SVGが大きすぎます");
    const documentXml = new DOMParser().parseFromString(text, "image/svg+xml");
    if (!documentXml.documentElement || documentXml.documentElement.localName.toLowerCase() !== "svg" || documentXml.querySelector("parsererror")) {
      throw new Error("SVGを安全に読み込めません");
    }

    const forbidden = new Set(["script", "foreignobject", "iframe", "object", "embed", "audio", "video", "a", "animate", "animatemotion", "animatetransform", "set", "switch"]);
    const removable = new Set(["metadata", "title", "desc"]);
    const walker = documentXml.createTreeWalker(documentXml.documentElement, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_COMMENT);
    const nodes = [];
    let current = walker.currentNode;
    let count = 0;
    while (current) {
      nodes.push(current);
      count += 1;
      if (count > 100000) throw new Error("SVGの要素数が多すぎます");
      current = walker.nextNode();
    }

    for (const node of nodes) {
      if (node.nodeType === Node.COMMENT_NODE) {
        node.parentNode?.removeChild(node);
        continue;
      }
      const name = node.localName.toLowerCase();
      if (forbidden.has(name)) throw new Error("安全のため、このSVGの動きを無効にしました");
      if (removable.has(name)) {
        node.parentNode?.removeChild(node);
        continue;
      }
      for (const attribute of Array.from(node.attributes)) {
        const attributeName = attribute.name.toLowerCase();
        const value = attribute.value.trim();
        if (attributeName.startsWith("on") || attributeName.startsWith("data-") || attributeName.startsWith("inkscape:") || attributeName.startsWith("sodipodi:")) {
          node.removeAttribute(attribute.name);
          continue;
        }
        if (attributeName === "href" || attributeName === "xlink:href") {
          if (!value.startsWith("#")) throw new Error("外部参照を含むSVGは処理できません");
        }
        if (attributeName === "style" && /url\s*\(|@import|javascript:/i.test(value)) {
          throw new Error("外部参照を含むSVGは処理できません");
        }
        if (/javascript\s*:/i.test(value)) throw new Error("安全でないSVGを処理できません");
      }
    }
    return new XMLSerializer().serializeToString(documentXml.documentElement);
  }

  function loadImage(url) {
    return new Promise((resolve, reject) => {
      const image = new Image();
      image.decoding = "async";
      image.onload = () => resolve(image);
      image.onerror = () => reject(new Error("画像を読み込めません。ブラウザがこの形式に対応しているか確認してください"));
      image.src = url;
    });
  }

  function canvasToBlob(canvas, type, quality) {
    return new Promise((resolve, reject) => {
      canvas.toBlob((blob) => {
        if (blob) resolve(blob);
        else reject(new Error("この端末では選択した形式で保存できません"));
      }, type, quality);
    });
  }

  function makeProcessingPlan(report, sourceKey) {
    const orientation = report.orientation || 1;
    const dimensions = report.width && report.height ? { width: report.width, height: report.height } : null;
    const visual = dimensions && needsSwappedOrientation(orientation) ? { width: dimensions.height, height: dimensions.width } : dimensions;
    const limit = getPixelLimit();
    if (visual && (visual.width > MAX_CANVAS_DIMENSION || visual.height > MAX_CANVAS_DIMENSION) && elements.largeImageSelect.value === "original") {
      throw new Error("画像の一辺が大きすぎます。安全設定に切り替えてやり直してください");
    }
    if (visual && visual.width * visual.height > MAX_SAFE_PIXELS && elements.largeImageSelect.value === "original") {
      throw new Error("画像の画素数が端末の上限を超えています。安全設定に切り替えてやり直してください");
    }
    if (!visual) return { scaled: false, resizeWidth: null, resizeHeight: null };
    const target = fitDimensions(visual.width, visual.height, limit);
    const scaled = target.scaled || visual.width > MAX_CANVAS_DIMENSION || visual.height > MAX_CANVAS_DIMENSION;
    return {
      scaled,
      resizeWidth: scaled ? target.width : null,
      resizeHeight: scaled ? target.height : null,
      sourceKey
    };
  }

  function getPixelLimit() {
    return elements.largeImageSelect.value === "safe" ? devicePixelBudget : MAX_SAFE_PIXELS;
  }

  function fitDimensions(width, height, pixelLimit) {
    let targetWidth = Math.max(1, Math.floor(width));
    let targetHeight = Math.max(1, Math.floor(height));
    const scaleByPixels = Math.sqrt(pixelLimit / (targetWidth * targetHeight));
    const scaleByDimension = Math.min(MAX_CANVAS_DIMENSION / targetWidth, MAX_CANVAS_DIMENSION / targetHeight, 1);
    const scale = Math.min(scaleByPixels < 1 ? scaleByPixels : 1, scaleByDimension);
    if (scale < 1) {
      targetWidth = Math.max(1, Math.floor(targetWidth * scale));
      targetHeight = Math.max(1, Math.floor(targetHeight * scale));
    }
    return { width: targetWidth, height: targetHeight, scaled: scale < 0.9999 };
  }

  function chooseOutput(sourceKey) {
    if (sourceKey === "jpeg") return { type: "image/jpeg", extension: ".jpg", label: "JPEG" };
    if (sourceKey === "png") return { type: "image/png", extension: ".png", label: "PNG" };
    if (sourceKey === "webp") return { type: "image/webp", extension: ".webp", label: "WebP" };
    if (sourceKey === "gif") return { type: "image/png", extension: ".png", label: "PNG", note: "GIFは先頭フレームを静止画として保存" };
    if (sourceKey === "svg") return { type: "image/png", extension: ".png", label: "PNG", note: "安全化したSVGをPNGとして保存" };
    return { type: "image/webp", extension: ".webp", label: "WebP", note: `${FORMAT_LABELS[sourceKey] || "画像"}をWebPとして保存` };
  }

  function resolveActualOutput(type, spec) {
    const actualType = String(type || spec.type).toLowerCase();
    if (actualType === "image/jpeg") return { type: actualType, extension: ".jpg", label: "JPEG" };
    if (actualType === "image/webp") return { type: actualType, extension: ".webp", label: "WebP" };
    return { type: "image/png", extension: ".png", label: "PNG" };
  }

  function buildOutputWarning(sourceKey, actualSpec, scaled, report) {
    const warnings = [];
    const chosen = chooseOutput(sourceKey);
    if (chosen.note) warnings.push(chosen.note);
    if (actualSpec.type !== chosen.type) warnings.push("端末の保存対応に合わせてPNGに変更");
    if (scaled) warnings.push("端末の安全上限に合わせて縮小");
    if (sourceKey === "jpeg" || sourceKey === "webp") warnings.push(`画質設定 ${Math.round(Number(elements.qualitySelect.value) * 100)}`);
    if (report.animated) warnings.push("アニメーションは先頭フレームのみ");
    return warnings.join("。 ");
  }

  async function readAnalysisBuffer(file) {
    return file.slice(0, Math.min(file.size, ANALYSIS_BYTES)).arrayBuffer();
  }

  function inspectMetadata(buffer, formatKey) {
    const report = {
      entries: [],
      sensitive: false,
      orientation: 1,
      width: null,
      height: null,
      animated: false,
      truncated: buffer.byteLength >= ANALYSIS_BYTES
    };
    if (formatKey === "jpeg") inspectJpeg(buffer, report);
    else if (formatKey === "png") inspectPng(buffer, report);
    else if (formatKey === "webp") inspectWebp(buffer, report);
    else if (formatKey === "gif") inspectGif(buffer, report);
    else if (formatKey === "bmp") inspectBmp(buffer, report);
    else if (formatKey === "tiff") applyTiffReport(parseTiff(new DataView(buffer), 0, buffer.byteLength), report);
    return report;
  }

  function inspectJpeg(buffer, report) {
    const view = new DataView(buffer);
    if (view.byteLength < 4 || view.getUint16(0) !== 0xffd8) return;
    let offset = 2;
    while (offset + 3 < view.byteLength) {
      if (view.getUint8(offset) !== 0xff) {
        offset += 1;
        continue;
      }
      while (offset < view.byteLength && view.getUint8(offset) === 0xff) offset += 1;
      const marker = view.getUint8(offset);
      offset += 1;
      if (marker === 0xda || marker === 0xd9) break;
      if (marker === 0x01 || marker >= 0xd0 && marker <= 0xd7) continue;
      if (offset + 2 > view.byteLength) break;
      const length = view.getUint16(offset);
      if (length < 2 || offset + length > view.byteLength) break;
      const dataStart = offset + 2;
      const dataEnd = offset + length;
      if (isJpegFrameMarker(marker) && dataStart + 5 < dataEnd) {
        report.height = view.getUint16(dataStart + 1);
        report.width = view.getUint16(dataStart + 3);
      }
      if (marker === 0xe1) {
        const prefix = ascii(new Uint8Array(buffer, dataStart, Math.min(32, dataEnd - dataStart)));
        if (prefix.startsWith("Exif\u0000\u0000")) {
          applyTiffReport(parseTiff(view, dataStart + 6, dataEnd), report);
        } else if (/xmp|adobe/i.test(prefix) || ascii(new Uint8Array(buffer, dataStart, Math.min(256, dataEnd - dataStart))).includes("<x:xmpmeta")) {
          addMetadata(report, "XMP情報", true);
        } else {
          addMetadata(report, "アプリ固有情報", true);
        }
      } else if (marker === 0xed) {
        addMetadata(report, "IPTC情報", true);
      } else if (marker === 0xfe) {
        addMetadata(report, "コメント", true);
      } else if (marker === 0xe2) {
        const prefix = ascii(new Uint8Array(buffer, dataStart, Math.min(16, dataEnd - dataStart)));
        if (prefix.startsWith("ICC_PROFILE")) addMetadata(report, "色設定", false);
        else addMetadata(report, "アプリ固有情報", true);
      } else if (marker === 0xe0) {
        addMetadata(report, "標準表示情報", false);
      } else if (marker >= 0xe1 && marker <= 0xef) {
        addMetadata(report, "アプリ固有情報", true);
      }
      offset += length;
    }
  }

  function isJpegFrameMarker(marker) {
    return marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker);
  }

  function inspectPng(buffer, report) {
    const view = new DataView(buffer);
    if (view.byteLength < 33) return;
    report.width = view.getUint32(16);
    report.height = view.getUint32(20);
    let offset = 8;
    while (offset + 12 <= view.byteLength) {
      const length = view.getUint32(offset);
      const type = ascii(new Uint8Array(buffer, offset + 4, 4));
      if (offset + 12 + length > view.byteLength) break;
      if (type === "eXIf") addMetadata(report, "Exif情報", true);
      else if (["tEXt", "zTXt", "iTXt"].includes(type)) addMetadata(report, "説明とコメント", true);
      else if (type === "tIME") addMetadata(report, "更新日時", true);
      else if (type === "iCCP" || type === "sRGB" || type === "cHRM" || type === "gAMA") addMetadata(report, "色設定", false);
      else if (type === "pHYs") addMetadata(report, "解像度設定", false);
      else if (type[0] === type[0].toLowerCase() && !["IHDR", "IDAT", "IEND"].includes(type)) addMetadata(report, "補助情報", true);
      offset += 12 + length;
      if (type === "IEND") break;
    }
  }

  function inspectWebp(buffer, report) {
    const bytes = new Uint8Array(buffer);
    if (bytes.length < 16 || ascii(bytes.slice(0, 4)) !== "RIFF" || ascii(bytes.slice(8, 12)) !== "WEBP") return;
    let offset = 12;
    while (offset + 8 <= bytes.length) {
      const type = ascii(bytes.slice(offset, offset + 4));
      const length = readUint32LE(bytes, offset + 4);
      const dataStart = offset + 8;
      const dataEnd = Math.min(bytes.length, dataStart + length);
      if (dataStart + length > bytes.length) break;
      if (type === "VP8X" && dataEnd >= dataStart + 10) {
        report.width = 1 + readUint24LE(bytes, dataStart + 4);
        report.height = 1 + readUint24LE(bytes, dataStart + 7);
      } else if (type === "VP8 " && dataEnd >= dataStart + 10 && bytes[dataStart + 3] === 0x9d && bytes[dataStart + 4] === 0x01 && bytes[dataStart + 5] === 0x2a) {
        report.width = readUint16LE(bytes, dataStart + 6) & 0x3fff;
        report.height = readUint16LE(bytes, dataStart + 8) & 0x3fff;
      } else if (type === "VP8L" && dataEnd >= dataStart + 5 && bytes[dataStart] === 0x2f) {
        const widthBits = bytes[dataStart + 1] | bytes[dataStart + 2] << 8;
        const heightBits = (bytes[dataStart + 2] >> 6) | bytes[dataStart + 3] << 2 | bytes[dataStart + 4] << 10;
        report.width = 1 + (widthBits & 0x3fff);
        report.height = 1 + (heightBits & 0x3fff);
      } else if (type === "EXIF") {
        const exifStart = startsWithBytes(bytes, dataStart, [0x45, 0x78, 0x69, 0x66, 0x00, 0x00]) ? dataStart + 6 : dataStart;
        applyTiffReport(parseTiff(new DataView(buffer), exifStart, dataEnd), report);
      } else if (type === "XMP ") addMetadata(report, "XMP情報", true);
      else if (type === "ICCP") addMetadata(report, "色設定", false);
      else if (type === "ANIM" || type === "ANMF") report.animated = true;
      else if (type === "LIST") addMetadata(report, "アプリ固有情報", true);
      offset = dataEnd + (length % 2);
    }
  }

  function inspectGif(buffer, report) {
    const bytes = new Uint8Array(buffer);
    if (bytes.length < 13) return;
    report.width = readUint16LE(bytes, 6);
    report.height = readUint16LE(bytes, 8);
    let offset = 13;
    const packed = bytes[10];
    if (packed & 0x80) offset += 3 * (2 ** ((packed & 0x07) + 1));
    let frames = 0;
    while (offset < bytes.length) {
      const marker = bytes[offset++];
      if (marker === 0x3b) break;
      if (marker === 0x2c) {
        frames += 1;
        if (offset + 9 > bytes.length) break;
        const imagePacked = bytes[offset + 8];
        offset += 9;
        if (imagePacked & 0x80) offset += 3 * (2 ** ((imagePacked & 0x07) + 1));
        offset = skipGifSubBlocks(bytes, offset);
      } else if (marker === 0x21) {
        const label = bytes[offset++];
        if (label === 0xfe) addMetadata(report, "コメント", true);
        if (label === 0xff) {
          if (offset >= bytes.length) break;
          const blockSize = bytes[offset];
          const application = ascii(bytes.slice(offset + 1, offset + 1 + Math.min(blockSize, 11)));
          if (/xmp|comment|meta/i.test(application)) addMetadata(report, "アプリ固有情報", true);
        }
        offset = skipGifSubBlocks(bytes, offset);
      } else {
        break;
      }
    }
    report.animated = frames > 1;
  }

  function skipGifSubBlocks(bytes, offset) {
    while (offset < bytes.length) {
      const size = bytes[offset++];
      if (size === 0) break;
      offset += size;
    }
    return offset;
  }

  function inspectBmp(buffer, report) {
    const bytes = new Uint8Array(buffer);
    if (bytes.length < 26) return;
    report.width = Math.abs(readInt32LE(bytes, 18));
    report.height = Math.abs(readInt32LE(bytes, 22));
  }

  function addMetadata(report, label, sensitive) {
    if (!report.entries.some((entry) => entry.label === label)) report.entries.push({ label, sensitive });
    if (sensitive) report.sensitive = true;
  }

  function parseTiff(view, base, end) {
    const result = { tags: new Set(), orientation: 1, width: null, height: null };
    if (base < 0 || base + 8 > end || end > view.byteLength) return result;
    const order = view.getUint16(base);
    if (order !== 0x4949 && order !== 0x4d4d) return result;
    const little = order === 0x4949;
    const get16 = (offset) => view.getUint16(offset, little);
    const get32 = (offset) => view.getUint32(offset, little);
    if (get16(base + 2) !== 42) return result;
    const visited = new Set();
    const typeSizes = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 6: 1, 7: 1, 8: 2, 9: 4, 10: 8, 11: 4, 12: 8 };

    function readValue(entry, type, count) {
      const size = typeSizes[type];
      if (!size || count <= 0 || count > 100000) return null;
      const total = size * count;
      const pointer = total <= 4 ? entry + 8 : base + get32(entry + 8);
      if (pointer < base || pointer + total > end) return null;
      if (type === 2 || type === 7) {
        const text = ascii(new Uint8Array(view.buffer, pointer, Math.min(total, 256))).replace(/\u0000.*$/, "");
        return text;
      }
      if (type === 3) return get16(pointer);
      if (type === 4 || type === 9) return get32(pointer);
      return null;
    }

    function walk(relativeOffset, depth) {
      if (depth > 5 || visited.has(relativeOffset)) return;
      const ifd = base + relativeOffset;
      if (ifd < base || ifd + 2 > end) return;
      visited.add(relativeOffset);
      const count = get16(ifd);
      if (count > 1000 || ifd + 2 + count * 12 + 4 > end) return;
      for (let index = 0; index < count; index += 1) {
        const entry = ifd + 2 + index * 12;
        const tag = get16(entry);
        const type = get16(entry + 2);
        const valueCount = get32(entry + 4);
        const value = readValue(entry, type, valueCount);
        result.tags.add(tag);
        if (tag === 0x0112 && typeof value === "number" && value >= 1 && value <= 8) result.orientation = value;
        if (tag === 0x0100 && typeof value === "number") result.width = value;
        if (tag === 0x0101 && typeof value === "number") result.height = value;
        if ((tag === 0x8769 || tag === 0x8825 || tag === 0x014a) && typeof value === "number") walk(value, depth + 1);
      }
    }

    const firstIfd = get32(base + 4);
    walk(firstIfd, 0);
    return result;
  }

  function applyTiffReport(tiff, report) {
    if (!tiff) return;
    if (tiff.width && tiff.height) {
      report.width = report.width || tiff.width;
      report.height = report.height || tiff.height;
    }
    report.orientation = tiff.orientation || report.orientation || 1;
    const tags = tiff.tags || new Set();
    if (tags.has(0x8825)) addMetadata(report, "GPS位置情報", true);
    if (tags.has(0x9003) || tags.has(0x9004) || tags.has(0x0132)) addMetadata(report, "撮影日時", true);
    if (tags.has(0x010f) || tags.has(0x0110) || tags.has(0x0131) || tags.has(0xa433) || tags.has(0xa434)) addMetadata(report, "機種とソフトウェア", true);
    if (tags.has(0x013b) || tags.has(0x8298)) addMetadata(report, "作者と著作権", true);
    if (tags.has(0x9286) || tags.has(0xa420)) addMetadata(report, "ユーザーコメント", true);
    if (tags.size && !report.entries.length) addMetadata(report, "Exif付加情報", true);
  }

  function readUint16LE(bytes, offset) {
    return offset + 1 < bytes.length ? bytes[offset] | bytes[offset + 1] << 8 : 0;
  }

  function readInt32LE(bytes, offset) {
    return offset + 3 < bytes.length ? (bytes[offset] | bytes[offset + 1] << 8 | bytes[offset + 2] << 16 | bytes[offset + 3] << 24) : 0;
  }

  function readUint32LE(bytes, offset) {
    return offset + 3 < bytes.length ? (bytes[offset] | bytes[offset + 1] << 8 | bytes[offset + 2] << 16 | bytes[offset + 3] << 24) >>> 0 : 0;
  }

  function readUint24LE(bytes, offset) {
    return offset + 2 < bytes.length ? bytes[offset] | bytes[offset + 1] << 8 | bytes[offset + 2] << 16 : 0;
  }

  function startsWithBytes(bytes, offset, prefix) {
    return prefix.every((value, index) => bytes[offset + index] === value);
  }

  function ascii(bytes) {
    let result = "";
    for (const byte of bytes) result += byte >= 32 && byte <= 126 ? String.fromCharCode(byte) : String.fromCharCode(byte);
    return result;
  }

  function decodeText(bytes) {
    try {
      return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
    } catch (error) {
      return ascii(bytes);
    }
  }

  function needsSwappedOrientation(orientation) {
    return orientation >= 5 && orientation <= 8;
  }

  function applyOrientation(context, orientation, width, height) {
    switch (orientation) {
      case 2:
        context.translate(width, 0);
        context.scale(-1, 1);
        break;
      case 3:
        context.translate(width, height);
        context.rotate(Math.PI);
        break;
      case 4:
        context.translate(0, height);
        context.scale(1, -1);
        break;
      case 5:
        context.rotate(0.5 * Math.PI);
        context.scale(1, -1);
        break;
      case 6:
        context.translate(height, 0);
        context.rotate(0.5 * Math.PI);
        break;
      case 7:
        context.translate(height, 0);
        context.rotate(0.5 * Math.PI);
        context.scale(-1, 1);
        break;
      case 8:
        context.translate(0, width);
        context.rotate(-0.5 * Math.PI);
        break;
      default:
        break;
    }
  }

  function handleResultAction(event) {
    const button = event.target.closest("[data-action]");
    if (!button) return;
    const item = state.items.find((candidate) => candidate.id === button.dataset.id);
    if (!item) return;
    const action = button.dataset.action;
    if (action === "retry") {
      item.status = "waiting";
      item.error = "";
      state.notice = `${item.file.name}を待機一覧に戻しました`;
      render();
      processPending();
    } else if (action === "remove") {
      removeItem(item);
    } else if (action === "preview") {
      state.previewId = item.id;
      state.notice = `${item.outputName}をプレビューしています`;
      render();
    }
  }

  function removeItem(item) {
    if (state.processing) return;
    releaseItemOutput(item);
    state.items = state.items.filter((candidate) => candidate.id !== item.id);
    if (state.previewId === item.id) state.previewId = null;
    state.notice = `${item.file.name}を一覧から外しました`;
    render();
  }

  function downloadAll() {
    const completed = state.items.filter((item) => item.status === "success" && item.outputUrl);
    if (!completed.length || state.processing) return;
    completed.forEach((item, index) => {
      window.setTimeout(() => {
        const link = document.createElement("a");
        link.href = item.outputUrl;
        link.download = item.outputName;
        link.rel = "noopener";
        document.body.appendChild(link);
        link.click();
        link.remove();
      }, index * 350);
    });
    state.notice = "完了分の保存を順番に開始しました。端末によっては保存の確認が表示されます";
    render();
  }

  function resetAll() {
    state.runId += 1;
    state.processing = false;
    state.notice = "一覧を空にしました。新しい画像を選べます";
    state.previewId = null;
    state.items.forEach(releaseItemOutput);
    state.items = [];
    terminateWorker(new Error("CANCELLED"));
    render();
  }

  function releaseItemOutput(item) {
    if (item.outputUrl) URL.revokeObjectURL(item.outputUrl);
    item.outputUrl = "";
    item.outputBlob = null;
  }

  function terminateWorker(error) {
    rejectWorkerRequests(error);
    if (state.worker) state.worker.terminate();
    state.worker = null;
  }

  function releaseResources() {
    state.items.forEach(releaseItemOutput);
    terminateWorker(new Error("CANCELLED"));
  }

  function render() {
    const items = state.items;
    const successCount = items.filter((item) => item.status === "success").length;
    const completedCount = items.filter((item) => item.status === "success" || item.status === "error").length;
    const waitingCount = items.filter((item) => item.status === "waiting").length;
    const percent = items.length ? Math.round(completedCount / items.length * 100) : 0;

    elements.queuePanel.hidden = items.length === 0;
    elements.resultsPanel.hidden = items.length === 0;
    elements.queueCount.textContent = `${items.length}個`;
    elements.queueStatus.textContent = state.processing ? `${completedCount}/${items.length}個を処理しました` : state.notice || (waitingCount ? `${waitingCount}個が待機中です` : "画像を追加してください");
    elements.progressBar.style.width = `${percent}%`;
    elements.progressPercent.textContent = `${percent}%`;
    elements.startButton.disabled = state.processing || waitingCount === 0;
    elements.startButton.textContent = state.processing ? "処理中" : waitingCount ? `処理を開始（${waitingCount}個）` : "処理済み";
    elements.downloadAllButton.disabled = state.processing || successCount === 0;
    elements.resetButton.textContent = state.processing ? "中止してやり直す" : "やり直す";

    elements.resultsList.replaceChildren(...items.map(renderResultItem));
    const previewItem = items.find((item) => item.id === state.previewId && item.status === "success") || items.find((item) => item.status === "success");
    elements.previewPanel.hidden = !previewItem;
    if (previewItem) {
      if (elements.previewImage.src !== previewItem.outputUrl) elements.previewImage.src = previewItem.outputUrl;
      elements.previewCaption.textContent = `${previewItem.outputName}。${previewItem.width} × ${previewItem.height}。保存前に画像の見た目を確認できます`;
    } else {
      elements.previewImage.removeAttribute("src");
      elements.previewCaption.textContent = "";
    }
  }

  function renderResultItem(item) {
    const article = document.createElement("article");
    article.className = "result-item";
    article.dataset.status = item.status;
    article.dataset.id = item.id;
    article.setAttribute("role", "listitem");

    const top = document.createElement("div");
    top.className = "result-topline";
    const name = document.createElement("strong");
    name.className = "result-name";
    name.textContent = item.file.name;
    const badge = document.createElement("span");
    badge.className = "status-badge";
    badge.textContent = STATUS_LABELS[item.status];
    top.append(name, badge);
    article.appendChild(top);

    const meta = document.createElement("div");
    meta.className = "result-meta";
    meta.textContent = `${item.format.label}　${formatBytes(item.file.size)}`;
    if (item.width && item.height) meta.append(`　${item.width} × ${item.height}`);
    article.appendChild(meta);

    if (item.status === "success") {
      const detail = document.createElement("p");
      detail.className = "result-detail";
      detail.append("出力 ");
      const strong = document.createElement("strong");
      strong.textContent = item.outputName;
      detail.append(strong, `　${formatBytes(item.outputBlob?.size || 0)}　${formatDuration(item.duration)}`);
      article.appendChild(detail);

      const verification = document.createElement("p");
      verification.className = "result-message";
      verification.textContent = item.verification ? "標準解析で個人情報領域が残っていないことを確認しました" : "出力の自動確認が十分でないため、保存前に内容を確認してください";
      article.appendChild(verification);

      if (item.metadata) {
        const metadata = document.createElement("p");
        metadata.className = "result-message";
        metadata.textContent = metadataSummary(item.metadata);
        article.appendChild(metadata);
      }
      if (item.warning) {
        const warning = document.createElement("p");
        warning.className = "result-warning";
        warning.textContent = item.warning;
        article.appendChild(warning);
      }
    }

    if (item.status === "error") {
      const error = document.createElement("p");
      error.className = "result-message error-message";
      error.textContent = item.error;
      article.appendChild(error);
    }

    const actions = document.createElement("div");
    actions.className = "result-actions";
    if (item.status === "success") {
      const download = document.createElement("a");
      download.className = "result-action primary";
      download.href = item.outputUrl;
      download.download = item.outputName;
      download.textContent = "保存";
      actions.appendChild(download);
      actions.appendChild(makeActionButton("プレビュー", "preview", item.id, "secondary"));
      actions.appendChild(makeActionButton("もう一度処理", "retry", item.id, "quiet"));
    } else if (item.status === "error") {
      actions.appendChild(makeActionButton("もう一度処理", "retry", item.id, "secondary"));
      actions.appendChild(makeActionButton("一覧から外す", "remove", item.id, "quiet"));
    } else if (item.status === "waiting") {
      actions.appendChild(makeActionButton("一覧から外す", "remove", item.id, "quiet"));
    }
    if (actions.children.length) article.appendChild(actions);
    return article;
  }

  function makeActionButton(label, action, id, style) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `result-action ${style}`;
    button.dataset.action = action;
    button.dataset.id = id;
    button.textContent = label;
    return button;
  }

  function metadataSummary(report) {
    if (!report.entries.length) return "標準解析で個人情報に当たる領域は見つかりませんでした";
    const labels = report.entries.map((entry) => entry.label).slice(0, 4).join("、");
    return report.sensitive ? `入力から検出した領域　${labels}。出力では画素から再生成しています` : `入力には表示用の付加情報がありました　${labels}`;
  }

  function formatKeyFromMime(mime) {
    const value = String(mime || "").toLowerCase();
    if (value === "image/jpeg") return "jpeg";
    if (value === "image/png") return "png";
    if (value === "image/webp") return "webp";
    if (value === "image/gif") return "gif";
    if (value === "image/bmp") return "bmp";
    if (value === "image/tiff") return "tiff";
    return "browser";
  }

  function makeOutputName(name, extension) {
    const base = String(name || "image").replace(/\.[^/.]+$/, "").normalize("NFKC").replace(/[\\/:*?"<>|\u0000-\u001f\u007f]/g, "_").replace(/\s+/g, " ").trim().slice(0, 96) || "image";
    return `${base}-no-metadata${extension}`;
  }

  function getExtension(name) {
    const match = String(name || "").toLowerCase().match(/\.([a-z0-9]+)$/);
    return match ? match[1] : "";
  }

  function formatBytes(bytes) {
    if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
    const units = ["B", "KB", "MB", "GB"];
    const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
    const value = bytes / (1024 ** index);
    return `${Number(value.toFixed(index ? 1 : 0))} ${units[index]}`;
  }

  function formatPixels(pixels) {
    return `${Number((pixels / 1000000).toFixed(1))}MP`;
  }

  function formatDuration(milliseconds) {
    if (!milliseconds || milliseconds < 1000) return `${Math.max(1, Math.round(milliseconds || 1))}ms`;
    return `${(milliseconds / 1000).toFixed(1)}秒`;
  }

  function normalizeError(error) {
    const message = String(error?.message || error || "処理できませんでした");
    if (/memory|allocation|canvas|too large|大きすぎ|画素数|上限/i.test(message)) return `${message}。安全設定に切り替えるか、画像を小さくしてやり直してください`;
    if (/decode|読み込|形式|unsupported|not supported/i.test(message)) return "このブラウザでは画像を読み込めません。別のブラウザか、対応形式へ変換してからやり直してください";
    return message;
  }

  function yieldToBrowser() {
    return new Promise((resolve) => window.setTimeout(resolve, 0));
  }

  init();
})();

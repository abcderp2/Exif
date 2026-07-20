(() => {
  "use strict";

  const MAX_FILE_BYTES = 32 * 1024 * 1024;
  const MAX_TOTAL_BYTES = 96 * 1024 * 1024;
  const MAX_FILES = 20;
  const MAX_CANVAS_PIXELS = 32 * 1000 * 1000;
  const MAX_CANVAS_DIMENSION = 8192;
  const WORKER_PATH = "image-worker.js";

  const STATUS_LABELS = {
    analyzing: "分析中",
    waiting: "待機中",
    processing: "処理中",
    success: "完了",
    error: "確認が必要"
  };

  const OUTPUT_SPECS = {
    jpeg: { key: "jpeg", type: "image/jpeg", extension: ".jpg", label: "JPEG" },
    png: { key: "png", type: "image/png", extension: ".png", label: "PNG" },
    webp: { key: "webp", type: "image/webp", extension: ".webp", label: "WebP" }
  };

  const elements = {
    dropZone: document.getElementById("dropZone"),
    fileInput: document.getElementById("fileInput"),
    outputFormatSelect: document.getElementById("outputFormatSelect"),
    qualitySelect: document.getElementById("qualitySelect"),
    largeImageSelect: document.getElementById("largeImageSelect"),
    settingsNote: document.getElementById("settingsNote"),
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
    analyzing: false,
    processing: false,
    runId: 0,
    notice: "",
    previewId: null,
    worker: null,
    workerSequence: 0,
    workerRequests: new Map()
  };

  const outputSupport = detectOutputSupport();
  const devicePixelBudget = detectDevicePixelBudget();

  function detectOutputSupport() {
    const canvas = document.createElement("canvas");
    canvas.width = 1;
    canvas.height = 1;
    return {
      jpeg: canvas.toDataURL("image/jpeg").startsWith("data:image/jpeg"),
      png: canvas.toDataURL("image/png").startsWith("data:image/png"),
      webp: canvas.toDataURL("image/webp").startsWith("data:image/webp")
    };
  }

  function detectDevicePixelBudget() {
    const memoryValue = Number(navigator.deviceMemory);
    const coresValue = Number(navigator.hardwareConcurrency);
    const memory = Number.isFinite(memoryValue) && memoryValue > 0 ? memoryValue : 3;
    const cores = Number.isFinite(coresValue) && coresValue > 0 ? coresValue : 4;
    if (memory <= 2 || cores <= 2) return 8 * 1000 * 1000;
    if (memory <= 4 || cores <= 4) return 12 * 1000 * 1000;
    return 20 * 1000 * 1000;
  }

  function init() {
    if (!window.ImageMetadata) {
      showFatalError("分析機能を読み込めませんでした。ページを再読み込みしてください");
      return;
    }

    configureOutputOptions();
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

    elements.dropZone.addEventListener("drop", (event) => addFiles(Array.from(event.dataTransfer.files || [])));
    elements.outputFormatSelect.addEventListener("change", updateSettingsNote);
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

  function configureOutputOptions() {
    const webpOption = elements.outputFormatSelect.querySelector('option[value="webp"]');
    if (webpOption && !outputSupport.webp) {
      webpOption.disabled = true;
      webpOption.textContent = "WebP このブラウザでは保存不可";
    }
  }

  function showFatalError(message) {
    elements.dropZone.disabled = true;
    elements.dropZone.querySelector(".drop-zone-title").textContent = message;
  }

  function updateSettingsNote() {
    const formatValue = elements.outputFormatSelect.value;
    const quality = Math.round(Number(elements.qualitySelect.value) * 100);
    const safeMode = elements.largeImageSelect.value === "safe";
    const formatText = formatValue === "same" ? "入力と同じ形式" : OUTPUT_SPECS[formatValue]?.label || "選択形式";
    const sizeText = safeMode
      ? `大きな画像は、この端末の安全目安である約${formatPixels(devicePixelBudget)}まで縮小します。`
      : `元の大きさを優先しますが、約${formatPixels(MAX_CANVAS_PIXELS)}または一辺${MAX_CANVAS_DIMENSION}pxを超える画像は処理しません。`;
    const alphaText = formatValue === "jpeg" ? "透明部分は白になります。" : "";
    elements.settingsNote.textContent = `${formatText}で保存します。JPEGとWebPの画質は${quality}です。${alphaText}${sizeText}`;
  }

  async function addFiles(files) {
    if (!files.length || state.processing || state.analyzing) return;
    const analysisRunId = ++state.runId;
    state.analyzing = true;
    state.notice = "画像の形式と付加情報を確認しています";
    render();

    let totalBytes = state.items.reduce((sum, item) => sum + item.file.size, 0);
    let accepted = 0;
    const rejected = [];

    for (const file of files) {
      if (state.runId !== analysisRunId) return;
      if (state.items.length >= MAX_FILES) {
        rejected.push(`${file.name}は個数上限を超えています`);
        continue;
      }
      if (!file.size) {
        rejected.push(`${file.name}は空のファイルです`);
        continue;
      }
      if (file.size > MAX_FILE_BYTES) {
        rejected.push(`${file.name}は32MBを超えています`);
        continue;
      }
      if (totalBytes + file.size > MAX_TOTAL_BYTES) {
        rejected.push(`${file.name}を加えると合計96MBを超えます`);
        continue;
      }
      const key = makeFileKey(file);
      if (state.items.some((item) => item.key === key)) {
        rejected.push(`${file.name}はすでに一覧にあります`);
        continue;
      }

      let detected;
      try {
        detected = await ImageMetadata.detectFile(file);
        if (state.runId !== analysisRunId) return;
      } catch (error) {
        detected = null;
      }
      if (!detected) {
        rejected.push(`${file.name}はJPEG、PNG、WebPとして確認できません`);
        continue;
      }

      const item = {
        id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
        key,
        file,
        format: detected,
        status: "analyzing",
        metadata: null,
        outputMetadata: null,
        outputBlob: null,
        outputUrl: "",
        outputName: "",
        outputType: "",
        width: null,
        height: null,
        scaled: false,
        duration: 0,
        error: "",
        warning: buildDetectionWarning(detected)
      };
      state.items.push(item);
      totalBytes += file.size;
      accepted += 1;
      render();

      try {
        item.metadata = await ImageMetadata.inspectFile(file, detected.key);
        if (state.runId !== analysisRunId) return;
        item.status = "waiting";
      } catch (error) {
        item.status = "error";
        item.error = "画像の構造を確認できませんでした";
      }
      render();
      await yieldToBrowser();
    }

    if (state.runId !== analysisRunId) return;
    state.analyzing = false;
    const messages = [];
    if (accepted) messages.push(`${accepted}個の画像を追加しました`);
    if (rejected.length) messages.push(rejected.slice(0, 2).join("。") + (rejected.length > 2 ? "。ほかにも追加できない画像があります" : ""));
    state.notice = messages.join("。") || "追加できる画像がありませんでした";
    render();
  }

  function buildDetectionWarning(detected) {
    const warnings = [];
    if (detected.extensionMismatch) warnings.push("拡張子とファイル本体の形式が一致しません");
    if (detected.declaredTypeMismatch) warnings.push("ブラウザが示した種類とファイル本体が一致しません");
    return warnings.join("。 ");
  }

  function makeFileKey(file) {
    return [file.name, file.size, file.lastModified, file.type].join("|");
  }

  async function processPending() {
    if (state.processing || state.analyzing) return;
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
      render();
      await yieldToBrowser();
    }

    if (state.runId === runId) {
      state.processing = false;
      const success = state.items.filter((item) => item.status === "success").length;
      const errors = state.items.filter((item) => item.status === "error").length;
      state.notice = errors
        ? `処理が終わりました。保存できる画像は${success}個、確認が必要な画像は${errors}個です`
        : `${success}個の画像を処理しました`;
      render();
    }
  }

  async function processItem(item, runId) {
    item.status = "processing";
    item.error = "";
    item.outputMetadata = null;
    releaseItemOutput(item);
    render();
    const started = performance.now();

    try {
      const spec = chooseOutput(item.format.key);
      if (!outputSupport[spec.key]) throw new Error(`${spec.label}形式で保存できないブラウザです`);
      const encoded = await encodeRaster(item.file, spec);
      if (state.runId !== runId) return;
      if (!encoded.blob || encoded.blob.type !== spec.type) throw new Error(`${spec.label}形式で正しく保存できませんでした`);

      const verification = await ImageMetadata.inspectFile(encoded.blob, spec.key);
      if (verification.sensitive || verification.structureIssues.length) {
        throw new Error("処理後の安全確認を通過しなかったため、保存用ファイルを破棄しました");
      }

      item.outputMetadata = verification;
      item.outputBlob = encoded.blob;
      item.outputUrl = URL.createObjectURL(encoded.blob);
      item.outputType = encoded.blob.type;
      item.outputName = makeOutputName(item.file.name, spec.extension);
      item.width = encoded.width;
      item.height = encoded.height;
      item.scaled = encoded.scaled;
      item.duration = performance.now() - started;
      item.warning = mergeWarnings(item.warning, buildOutputWarning(item, spec));
      item.status = "success";
      if (!state.previewId) state.previewId = item.id;
    } catch (error) {
      if (state.runId !== runId) return;
      releaseItemOutput(item);
      item.status = "error";
      item.duration = performance.now() - started;
      item.error = normalizeError(error);
    }
  }

  function chooseOutput(sourceKey) {
    const selected = elements.outputFormatSelect.value;
    return OUTPUT_SPECS[selected === "same" ? sourceKey : selected];
  }

  function buildOutputWarning(item, spec) {
    const warnings = [];
    if (item.format.key !== spec.key) warnings.push(`${item.format.label}から${spec.label}へ変換しました`);
    if (spec.key === "jpeg" && item.metadata?.alpha) warnings.push("透明部分を白で合成しました");
    if (item.metadata?.animated) warnings.push("アニメーションは先頭フレームの静止画になりました");
    if (item.scaled) warnings.push("端末の安全上限に合わせて縮小しました");
    if (spec.key === "jpeg" || spec.key === "webp") warnings.push(`画質${Math.round(Number(elements.qualitySelect.value) * 100)}`);
    if (item.metadata?.entries.some((entry) => !entry.sensitive)) warnings.push("色設定などは再生成により変わる場合があります");
    return warnings.join("。 ");
  }

  function mergeWarnings(first, second) {
    return [first, second].filter(Boolean).join("。 ");
  }

  async function encodeRaster(file, spec) {
    const workerResult = await tryWorkerEncode(file, spec);
    if (workerResult) return workerResult;
    return encodeOnMain(file, spec);
  }

  async function tryWorkerEncode(file, spec) {
    if (!window.Worker || !window.OffscreenCanvas || !window.createImageBitmap) return null;
    try {
      return await requestWorker({
        file,
        outputType: spec.type,
        quality: Number(elements.qualitySelect.value),
        maxPixels: getPixelLimit(),
        maxDimension: MAX_CANVAS_DIMENSION,
        fillWhite: spec.key === "jpeg",
        allowScale: elements.largeImageSelect.value === "safe"
      });
    } catch (error) {
      if (error?.code === "CANCELLED") throw error;
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

  async function encodeOnMain(file, spec) {
    let source = null;
    let sourceUrl = "";
    try {
      if (window.createImageBitmap) {
        try {
          source = await createImageBitmap(file, { imageOrientation: "from-image" });
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
      if (!sourceWidth || !sourceHeight) throw new Error("画像の大きさを確認できません");
      const target = fitDimensions(sourceWidth, sourceHeight, getPixelLimit(), MAX_CANVAS_DIMENSION);
      const canvas = document.createElement("canvas");
      canvas.width = target.width;
      canvas.height = target.height;
      const context = canvas.getContext("2d", { alpha: spec.key !== "jpeg" });
      if (!context) throw new Error("この端末では画像処理用の領域を作れません");
      context.imageSmoothingEnabled = true;
      context.imageSmoothingQuality = "high";
      if (spec.key === "jpeg") {
        context.fillStyle = "#ffffff";
        context.fillRect(0, 0, target.width, target.height);
      }
      context.drawImage(source, 0, 0, target.width, target.height);
      const blob = await canvasToBlob(canvas, spec.type, Number(elements.qualitySelect.value));
      return { blob, width: target.width, height: target.height, scaled: target.scaled };
    } finally {
      if (sourceUrl) URL.revokeObjectURL(sourceUrl);
      if (source && typeof source.close === "function") source.close();
    }
  }

  function loadImage(url) {
    return new Promise((resolve, reject) => {
      const image = new Image();
      image.decoding = "async";
      image.onload = () => resolve(image);
      image.onerror = () => reject(new Error("画像を読み込めません"));
      image.src = url;
    });
  }

  function canvasToBlob(canvas, type, quality) {
    return new Promise((resolve, reject) => {
      canvas.toBlob((blob) => {
        if (blob) resolve(blob);
        else reject(new Error("選択した形式で保存できません"));
      }, type, quality);
    });
  }

  function getPixelLimit() {
    return elements.largeImageSelect.value === "safe" ? devicePixelBudget : MAX_CANVAS_PIXELS;
  }

  function fitDimensions(width, height, pixelLimit, dimensionLimit) {
    let targetWidth = Math.max(1, Math.floor(width));
    let targetHeight = Math.max(1, Math.floor(height));
    const pixels = targetWidth * targetHeight;
    const scaleByPixels = Math.sqrt(pixelLimit / pixels);
    const scaleByDimension = Math.min(dimensionLimit / targetWidth, dimensionLimit / targetHeight, 1);
    const scale = Math.min(scaleByPixels < 1 ? scaleByPixels : 1, scaleByDimension);
    if (elements.largeImageSelect.value === "original" && scale < 1) {
      throw new Error("画像が端末向けの処理上限を超えています。安全設定へ切り替えてください");
    }
    if (scale < 1) {
      targetWidth = Math.max(1, Math.floor(targetWidth * scale));
      targetHeight = Math.max(1, Math.floor(targetHeight * scale));
    }
    return { width: targetWidth, height: targetHeight, scaled: scale < 0.9999 };
  }

  function handleResultAction(event) {
    const button = event.target.closest("[data-action]");
    if (!button) return;
    const item = state.items.find((candidate) => candidate.id === button.dataset.id);
    if (!item) return;
    const action = button.dataset.action;
    if (action === "retry") {
      releaseItemOutput(item);
      item.status = "waiting";
      item.error = "";
      item.outputMetadata = null;
      state.notice = `${item.file.name}を待機中へ戻しました`;
      render();
    } else if (action === "remove") {
      removeItem(item);
    } else if (action === "preview") {
      state.previewId = item.id;
      state.notice = `${item.outputName}を表示しています`;
      render();
    } else if (action === "report") {
      downloadAnalysisReport(item);
    }
  }

  function removeItem(item) {
    if (state.processing || state.analyzing) return;
    releaseItemOutput(item);
    state.items = state.items.filter((candidate) => candidate.id !== item.id);
    if (state.previewId === item.id) state.previewId = null;
    state.notice = `${item.file.name}を一覧から外しました`;
    render();
  }

  function downloadAnalysisReport(item) {
    if (!item.metadata) return;
    const report = ImageMetadata.toSafeObject(item.file, item.metadata);
    if (item.outputBlob && item.outputMetadata) {
      report.output = {
        name: item.outputName,
        type: item.outputType,
        size: item.outputBlob.size,
        width: item.width,
        height: item.height,
        metadataCheckPassed: !item.outputMetadata.sensitive && item.outputMetadata.structureIssues.length === 0
      };
    }
    const blob = new Blob([JSON.stringify(report, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = makeReportName(item.file.name);
    link.rel = "noopener";
    document.body.appendChild(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
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
      }, index * 400);
    });
    state.notice = "完了した画像の保存を順番に開始しました。端末によっては保存確認が表示されます";
    render();
  }

  function resetAll() {
    state.runId += 1;
    state.processing = false;
    state.analyzing = false;
    state.previewId = null;
    state.items.forEach(releaseItemOutput);
    state.items = [];
    terminateWorker(createCancellationError());
    state.notice = "一覧を空にしました。新しい画像を選べます";
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
    terminateWorker(createCancellationError());
  }

  function createCancellationError() {
    const error = new Error("CANCELLED");
    error.code = "CANCELLED";
    return error;
  }

  function render() {
    const items = state.items;
    const successCount = items.filter((item) => item.status === "success").length;
    const completedCount = items.filter((item) => item.status === "success" || item.status === "error").length;
    const waitingCount = items.filter((item) => item.status === "waiting").length;
    const analyzingCount = items.filter((item) => item.status === "analyzing").length;
    const percent = items.length ? Math.round(completedCount / items.length * 100) : 0;
    const busy = state.processing || state.analyzing;

    elements.queuePanel.hidden = items.length === 0;
    elements.resultsPanel.hidden = items.length === 0;
    elements.queueCount.textContent = `${items.length}個`;
    elements.queueStatus.textContent = state.processing
      ? `${completedCount}/${items.length}個を処理しました`
      : state.analyzing || analyzingCount
        ? "画像の形式と付加情報を確認しています"
        : state.notice || (waitingCount ? `${waitingCount}個が処理を待っています` : "画像を追加してください");
    elements.progressBar.style.width = `${percent}%`;
    elements.progressPercent.textContent = `${percent}%`;
    elements.startButton.disabled = busy || waitingCount === 0;
    elements.startButton.textContent = state.processing ? "処理中" : waitingCount ? `処理を開始 ${waitingCount}個` : "処理済み";
    elements.downloadAllButton.disabled = busy || successCount === 0;
    elements.resetButton.textContent = busy ? "中止してやり直す" : "やり直す";
    elements.outputFormatSelect.disabled = busy;
    elements.qualitySelect.disabled = busy;
    elements.largeImageSelect.disabled = busy;
    elements.fileInput.disabled = busy;
    elements.dropZone.disabled = busy;

    elements.resultsList.replaceChildren(...items.map(renderResultItem));
    const previewItem = items.find((item) => item.id === state.previewId && item.status === "success") || items.find((item) => item.status === "success");
    elements.previewPanel.hidden = !previewItem;
    if (previewItem) {
      if (elements.previewImage.src !== previewItem.outputUrl) elements.previewImage.src = previewItem.outputUrl;
      elements.previewCaption.textContent = `${previewItem.outputName}。${previewItem.width} × ${previewItem.height}。保存前に見た目を確認できます`;
    } else {
      elements.previewImage.removeAttribute("src");
      elements.previewCaption.textContent = "";
    }
  }

  function renderResultItem(item) {
    const article = document.createElement("article");
    article.className = "result-item";
    article.dataset.status = item.status;
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

    const baseMeta = document.createElement("p");
    baseMeta.className = "result-meta";
    const dimensions = item.metadata?.width && item.metadata?.height ? `　${item.metadata.width} × ${item.metadata.height}` : "";
    baseMeta.textContent = `${item.format.label}　${formatBytes(item.file.size)}${dimensions}`;
    article.appendChild(baseMeta);

    if (item.metadata) article.appendChild(renderAnalysisDetails(item));

    if (item.status === "success") {
      const output = document.createElement("p");
      output.className = "result-detail";
      output.append("出力 ");
      const strong = document.createElement("strong");
      strong.textContent = item.outputName;
      output.append(strong, `　${formatBytes(item.outputBlob?.size || 0)}　${formatDuration(item.duration)}`);
      article.appendChild(output);

      const verified = document.createElement("p");
      verified.className = "result-message success-message";
      verified.textContent = "処理後の形式構造を再確認し、個人情報領域がないことを確認しました";
      article.appendChild(verified);
    }

    if (item.warning) {
      const warning = document.createElement("p");
      warning.className = "result-warning";
      warning.textContent = item.warning;
      article.appendChild(warning);
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
      download.rel = "noopener";
      download.textContent = "画像を保存";
      actions.appendChild(download);
      actions.appendChild(makeActionButton("プレビュー", "preview", item.id, "secondary"));
      actions.appendChild(makeActionButton("分析結果を保存", "report", item.id, "quiet"));
      actions.appendChild(makeActionButton("設定を変えて再処理", "retry", item.id, "quiet"));
    } else if (item.status === "waiting") {
      actions.appendChild(makeActionButton("分析結果を保存", "report", item.id, "secondary"));
      actions.appendChild(makeActionButton("一覧から外す", "remove", item.id, "quiet"));
    } else if (item.status === "error") {
      if (item.metadata) actions.appendChild(makeActionButton("分析結果を保存", "report", item.id, "secondary"));
      actions.appendChild(makeActionButton("もう一度処理", "retry", item.id, "secondary"));
      actions.appendChild(makeActionButton("一覧から外す", "remove", item.id, "quiet"));
    }
    if (actions.children.length) article.appendChild(actions);
    return article;
  }

  function renderAnalysisDetails(item) {
    const report = item.metadata;
    const details = document.createElement("details");
    details.className = "analysis-details";
    const summary = document.createElement("summary");
    summary.textContent = report.sensitive ? "分析結果　付加情報あり" : "分析結果　個人情報領域なし";
    details.appendChild(summary);

    const overview = document.createElement("p");
    overview.className = "analysis-summary";
    overview.textContent = ImageMetadata.summary(report);
    details.appendChild(overview);

    const grid = document.createElement("dl");
    grid.className = "analysis-grid";
    appendDefinition(grid, "形式", report.formatLabel);
    appendDefinition(grid, "大きさ", report.width && report.height ? `${report.width} × ${report.height}` : "画像処理時に確認");
    appendDefinition(grid, "透明部分", report.alpha ? "あり" : "検出なし");
    appendDefinition(grid, "アニメーション", report.animated ? "あり" : "検出なし");
    appendDefinition(grid, "構造確認", report.structureIssues.length ? "注意あり" : report.scanComplete ? "完了" : "一部省略");
    details.appendChild(grid);

    if (report.entries.length) {
      const chips = document.createElement("div");
      chips.className = "metadata-chips";
      report.entries.forEach((entry) => {
        const chip = document.createElement("span");
        chip.className = entry.sensitive ? "metadata-chip sensitive" : "metadata-chip display";
        chip.textContent = entry.count > 1 ? `${entry.label} ${entry.count}件` : entry.label;
        chip.title = entry.detail;
        chips.appendChild(chip);
      });
      details.appendChild(chips);
    }

    [...report.structureIssues, ...report.warnings].forEach((message) => {
      const note = document.createElement("p");
      note.className = "analysis-note";
      note.textContent = message;
      details.appendChild(note);
    });
    return details;
  }

  function appendDefinition(list, termText, descriptionText) {
    const term = document.createElement("dt");
    term.textContent = termText;
    const description = document.createElement("dd");
    description.textContent = descriptionText;
    list.append(term, description);
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

  function makeOutputName(name, extension) {
    const base = safeBaseName(name);
    return `${base}-clean${extension}`;
  }

  function makeReportName(name) {
    return `${safeBaseName(name)}-analysis.json`;
  }

  function safeBaseName(name) {
    return String(name || "image")
      .replace(/\.[^/.]+$/, "")
      .normalize("NFKC")
      .replace(/[\\/:*?"<>|\u0000-\u001f\u007f]/g, "_")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 96) || "image";
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
    if (/memory|allocation|canvas|大き|画素|上限/i.test(message)) return `${message}。安全設定に切り替えるか、小さい画像でやり直してください`;
    if (/decode|読み込|形式|unsupported|not supported/i.test(message)) return "このブラウザでは画像を読み込めません。JPEG、PNG、WebPの別形式で保存し直してから試してください";
    return message;
  }

  function yieldToBrowser() {
    return new Promise((resolve) => window.setTimeout(resolve, 0));
  }

  init();
})();

(function (root, factory) {
  "use strict";
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  root.ReportExport = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const CSV_HEADERS = [
    "ファイル名",
    "入力形式",
    "Exif検知",
    "申告MIME",
    "入力サイズ(byte)",
    "幅",
    "高さ",
    "個人情報領域",
    "検出領域",
    "構造確認",
    "処理状態",
    "出力ファイル名",
    "出力形式",
    "出力サイズ(byte)",
    "出力幅",
    "出力高さ",
    "処理後検査",
    "注意",
    "エラー"
  ];

  function createBatchReport(reports) {
    const items = Array.isArray(reports) ? reports.map(cloneSafeValue) : [];
    return {
      schemaVersion: 1,
      reportType: "image-metadata-cleaner-batch",
      itemCount: items.length,
      items
    };
  }

  function stringifyJson(value) {
    return JSON.stringify(value, null, 2);
  }

  function toCsv(reports) {
    const safeReports = Array.isArray(reports) ? reports : [];
    const rows = safeReports.map(reportToRow);
    const lines = [CSV_HEADERS, ...rows].map((row) => row.map(csvCell).join(","));
    return `\uFEFF${lines.join("\r\n")}\r\n`;
  }

  function reportToRow(report) {
    const file = report?.file || {};
    const analysis = report?.analysis || {};
    const processing = report?.processing || {};
    const output = report?.output || {};
    const areas = Array.isArray(analysis.metadataAreas)
      ? analysis.metadataAreas.map((entry) => entry?.label).filter(Boolean).join(" / ")
      : "";
    const structure = Array.isArray(analysis.structureIssues) && analysis.structureIssues.length
      ? analysis.structureIssues.join(" / ")
      : analysis.scanComplete === false ? "一部省略" : "問題なし";

    return [
      file.name || "",
      analysis.format || "",
      analysis.exifDetected ? "検出" : "検出なし",
      file.declaredType || "",
      numberOrEmpty(file.size),
      numberOrEmpty(analysis.width),
      numberOrEmpty(analysis.height),
      analysis.sensitiveMetadataDetected ? "検出" : "検出なし",
      areas,
      structure,
      processing.statusLabel || processing.status || "",
      output.name || "",
      output.type || "",
      numberOrEmpty(output.size),
      numberOrEmpty(output.width),
      numberOrEmpty(output.height),
      output.exifDetected === false && output.metadataCheckPassed === true ? "Exif除去確認" : output.exifDetected === true ? "Exif残存" : output.metadataCheckPassed === false ? "未確認" : "未実施",
      output.metadataCheckPassed === true ? "通過" : output.metadataCheckPassed === false ? "不通過" : "未実施",
      processing.warning || "",
      processing.error || ""
    ];
  }

  function csvCell(value) {
    const protectedValue = protectSpreadsheetFormula(value);
    const escaped = protectedValue.replace(/"/g, '""');
    return /[",\r\n]/.test(escaped) ? `"${escaped}"` : escaped;
  }

  function protectSpreadsheetFormula(value) {
    const text = value == null ? "" : String(value).replace(/\u0000/g, "");
    return /^\s*[=+\-@]/.test(text) || /^[\t\r]/.test(text) ? `'${text}` : text;
  }

  function numberOrEmpty(value) {
    if (value == null || value === "") return "";
    const number = Number(value);
    return Number.isFinite(number) ? number : "";
  }

  function cloneSafeValue(value) {
    if (value == null || typeof value === "string" || typeof value === "boolean") return value;
    if (typeof value === "number") return Number.isFinite(value) ? value : null;
    if (Array.isArray(value)) return value.map(cloneSafeValue);
    if (typeof value === "object") {
      const copy = Object.create(null);
      Object.keys(value).forEach((key) => {
        if (key === "__proto__" || key === "constructor" || key === "prototype") return;
        copy[key] = cloneSafeValue(value[key]);
      });
      return copy;
    }
    return String(value);
  }

  return Object.freeze({
    CSV_HEADERS,
    createBatchReport,
    stringifyJson,
    toCsv,
    protectSpreadsheetFormula
  });
});

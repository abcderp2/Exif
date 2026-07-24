"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const Reports = require("../reports.js");

function sampleReport(name = "photo.jpg") {
  return {
    schemaVersion: 1,
    file: { name, size: 1234, declaredType: "image/jpeg" },
    analysis: {
      format: "JPEG",
      width: 640,
      height: 480,
      sensitiveMetadataDetected: true,
      metadataAreas: [{ label: "GPS位置情報", sensitive: true, count: 1 }],
      structureIssues: [],
      warnings: [],
      scanComplete: true
    },
    processing: { status: "success", statusLabel: "完了", warning: "", error: "" },
    output: {
      name: "photo-clean.jpg",
      type: "image/jpeg",
      size: 1000,
      width: 640,
      height: 480,
      metadataCheckPassed: true
    }
  };
}

test("batch JSON is deterministic and does not add local timestamps", () => {
  const report = Reports.createBatchReport([sampleReport()]);
  assert.equal(report.itemCount, 1);
  assert.equal(report.reportType, "image-metadata-cleaner-batch");
  assert.equal(Object.hasOwn(report, "generatedAt"), false);
  assert.match(Reports.stringifyJson(report), /photo-clean\.jpg/);
});

test("CSV includes a BOM and safe summary columns", () => {
  const csv = Reports.toCsv([sampleReport()]);
  assert.equal(csv.charCodeAt(0), 0xfeff);
  assert.match(csv, /GPS位置情報/);
  assert.match(csv, /処理後検査/);
  assert.doesNotMatch(csv, /latitude|longitude/i);
});

test("CSV prevents spreadsheet formula execution from file names", () => {
  const csv = Reports.toCsv([
    sampleReport("=HYPERLINK(\"https://example.invalid\")"),
    sampleReport("  +SUM(1,1).jpg")
  ]);
  assert.match(csv, /'=HYPERLINK/);
  assert.match(csv, /'  \+SUM/);
});

test("CSV keeps unknown numeric values empty", () => {
  const report = sampleReport();
  report.analysis.width = null;
  report.analysis.height = undefined;
  report.output = null;
  const csv = Reports.toCsv([report]);
  assert.doesNotMatch(csv, /,0,0,/);
  assert.match(csv, /JPEG,image\/jpeg,1234,,,検出/);
});

test("batch report clones source objects", () => {
  const source = sampleReport();
  const report = Reports.createBatchReport([source]);
  source.file.name = "changed.jpg";
  assert.equal(report.items[0].file.name, "photo.jpg");
});

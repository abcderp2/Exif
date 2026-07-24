import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { File } from "node:buffer";
import { createRequire } from "node:module";
import { chromium } from "@playwright/test";

const require = createRequire(import.meta.url);
const Metadata = require("../metadata.js");
const targetUrl = process.env.AUDIT_RELEASE_TARGET || "http://127.0.0.1:8000/";
const requiredAgents = [
  "*",
  "OAI-SearchBot",
  "GPTBot",
  "Claude-User",
  "Claude-SearchBot",
  "ClaudeBot",
  "Google-Extended"
];

const browser = await chromium.launch({ headless: true });

try {
  await auditRelease(targetUrl);
} finally {
  await browser.close();
}

async function auditRelease(url) {
  const context = await browser.newContext({
    viewport: { width: 360, height: 780 },
    deviceScaleFactor: 1,
    acceptDownloads: true
  });

  await context.addInitScript(() => {
    Object.defineProperty(navigator, "deviceMemory", { configurable: true, get: () => 2 });
    Object.defineProperty(navigator, "hardwareConcurrency", { configurable: true, get: () => 2 });
  });

  const page = await context.newPage();
  const consoleErrors = [];
  const pageErrors = [];
  const failedRequests = [];
  const outsideRequests = [];
  const expectedOrigin = new URL(url).origin;

  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  page.on("pageerror", (error) => pageErrors.push(String(error)));
  page.on("requestfailed", (request) => failedRequests.push(`${request.method()} ${request.url()} ${request.failure()?.errorText || ""}`));
  page.on("request", (request) => {
    const requestUrl = new URL(request.url());
    if (["http:", "https:"].includes(requestUrl.protocol) && requestUrl.origin !== expectedOrigin) outsideRequests.push(request.url());
  });

  const response = await page.goto(url, { waitUntil: "networkidle", timeout: 60000 });
  assert(response?.ok(), `公開確認対象を開けませんでした: ${url}`);
  assert.equal(await page.title(), "画像メタデータクリーナー");
  assert.equal(await page.locator("#dropZone").isEnabled(), true);
  assert.equal(await page.locator("#disclaimerTitle").count(), 1, "免責事項の本文が見つかりません");
  assert.equal(await page.locator('footer a[href="#disclaimerTitle"]').count(), 0, "不要な免責事項へのページ内リンクが残っています");

  await assertRobots(context, url);
  await assertNoHorizontalOverflow(page, 280, 720, "最小幅");
  await assertNoHorizontalOverflow(page, 320, 720, "小型スマートフォン");
  await assertNoHorizontalOverflow(page, 360, 780, "スマートフォン");
  await assertNoHorizontalOverflow(page, 768, 1024, "タブレット");
  await assertNoHorizontalOverflow(page, 1024, 768, "タブレット横向き");
  await assertNoHorizontalOverflow(page, 1440, 900, "パソコン");
  await page.setViewportSize({ width: 360, height: 780 });

  await testExifRemoval(page);
  await testBatchDragAndExports(page);

  assert.deepEqual(outsideRequests, [], `外部通信が発生しました: ${outsideRequests.join(", ")}`);
  assert.deepEqual(failedRequests, [], `通信失敗が発生しました: ${failedRequests.join(", ")}`);
  assert.deepEqual(pageErrors, [], `JavaScript例外が発生しました: ${pageErrors.join(" | ")}`);
  assert.deepEqual(consoleErrors, [], `console.errorが発生しました: ${consoleErrors.join(" | ")}`);

  await context.close();
  console.log(`${url} の公開品質監査に合格しました`);
}

async function assertRobots(context, baseUrl) {
  const robotsUrl = new URL("robots.txt", baseUrl).href;
  const response = await context.request.get(robotsUrl, { timeout: 30000 });
  assert(response.ok(), `robots.txtを取得できませんでした: ${robotsUrl}`);
  const text = await response.text();
  for (const agent of requiredAgents) {
    const escaped = agent.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const pattern = new RegExp(`User-agent:\\s*${escaped}\\s*[\\r\\n]+Allow:\\s*/(?:\\s|$)`, "i");
    assert(pattern.test(text), `robots.txtに${agent}の許可設定がありません`);
  }
}

async function assertNoHorizontalOverflow(page, width, height, label) {
  await page.setViewportSize({ width, height });
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  assert(overflow <= 1, `${label}で横方向に${overflow}pxはみ出しています`);
}

async function testExifRemoval(page) {
  await page.locator("#outputFormatSelect").selectOption("same");
  await setExifJpeg(page);
  await waitForReadyItems(page, 1);

  const summary = await page.locator(".analysis-details summary").innerText();
  assert(summary.includes("付加情報あり"), "Exif付き入力を付加情報ありとして認識できませんでした");
  const chips = await page.locator(".metadata-chip.sensitive").allTextContents();
  assert(chips.some((text) => text.includes("GPS位置情報")), "GPS位置情報を検出できませんでした");

  const [beforeReportDownload] = await Promise.all([
    page.waitForEvent("download"),
    page.locator("#exportJsonButton").click()
  ]);
  const beforeReportPath = await beforeReportDownload.path();
  assert(beforeReportPath, "処理前のJSON分析結果を取得できませんでした");
  const beforeReport = JSON.parse(await fs.readFile(beforeReportPath, "utf8"));
  assert.equal(beforeReport.itemCount, 1);
  assert.equal(beforeReport.items[0].analysis.sensitiveMetadataDetected, true);
  assert(JSON.stringify(beforeReport).includes("GPS位置情報"));
  assert(!/latitude|longitude/i.test(JSON.stringify(beforeReport)), "JSONに生の位置情報名が含まれています");

  await page.locator("#startButton").click();
  await page.waitForFunction(() => document.querySelector('.result-item[data-status="success"]'), null, { timeout: 60000 });

  const successText = await page.locator(".success-message").innerText();
  assert(successText.includes("個人情報領域がないことを確認"));

  const [imageDownload] = await Promise.all([
    page.waitForEvent("download"),
    page.locator("a.result-action.primary").click()
  ]);
  const imagePath = await imageDownload.path();
  assert(imagePath, "Exif除去後の画像を取得できませんでした");
  const imageBytes = await fs.readFile(imagePath);
  const outputFile = new File([imageBytes], imageDownload.suggestedFilename(), { type: "image/jpeg" });
  const detected = await Metadata.detectFile(outputFile);
  assert.equal(detected?.key, "jpeg", "Exif除去後の画像がJPEGとして確認できませんでした");
  const outputReport = await Metadata.inspectFile(outputFile, "jpeg");
  assert.equal(outputReport.sensitive, false, "Exif除去後の画像に個人情報領域が残っています");
  assert.deepEqual(outputReport.structureIssues, [], "Exif除去後の画像に構造異常があります");
  assert.equal(outputReport.entries.some((entry) => entry.key === "gps" || entry.key === "exif"), false, "ExifまたはGPS領域が残っています");

  const [afterReportDownload] = await Promise.all([
    page.waitForEvent("download"),
    page.getByRole("button", { name: /JSON分析結果|分析結果を保存/ }).first().click()
  ]);
  const afterReportPath = await afterReportDownload.path();
  assert(afterReportPath, "処理後のJSON分析結果を取得できませんでした");
  const afterReport = JSON.parse(await fs.readFile(afterReportPath, "utf8"));
  assert.equal(afterReport.output.metadataCheckPassed, true);

  await page.locator("#resetButton").click();
  await page.waitForFunction(() => document.querySelectorAll(".result-item").length === 0);
}

async function testBatchDragAndExports(page) {
  await page.evaluate(async () => {
    const transfer = new DataTransfer();
    const options = [
      { mime: "image/png", name: "batch-one.png", alpha: true },
      { mime: "image/jpeg", name: "=batch-two.jpg", alpha: false }
    ];

    for (const option of options) {
      const canvas = document.createElement("canvas");
      canvas.width = 48;
      canvas.height = 36;
      const context = canvas.getContext("2d");
      context.fillStyle = "#143b73";
      context.fillRect(0, 0, 48, 36);
      context.fillStyle = option.alpha ? "rgba(255, 190, 70, 0.45)" : "rgb(255, 190, 70)";
      context.fillRect(12, 9, 24, 18);
      const blob = await new Promise((resolve) => canvas.toBlob(resolve, option.mime, 0.92));
      if (!blob) throw new Error("一括監査画像を作成できません");
      transfer.items.add(new File([blob], option.name, { type: option.mime, lastModified: 1700000000000 }));
    }

    document.body.dispatchEvent(new DragEvent("dragenter", { bubbles: true, cancelable: true, dataTransfer: transfer }));
    if (document.querySelector("#dropOverlay")?.hidden) throw new Error("ドラッグ表示が開きませんでした");
    document.body.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: transfer }));
  });

  await waitForReadyItems(page, 2);
  assert.equal(await page.locator("#dropOverlay").isHidden(), true);

  const [jsonDownload] = await Promise.all([
    page.waitForEvent("download"),
    page.locator("#exportJsonButton").click()
  ]);
  const jsonPath = await jsonDownload.path();
  assert(jsonPath, "一括JSONを取得できませんでした");
  const batch = JSON.parse(await fs.readFile(jsonPath, "utf8"));
  assert.equal(batch.itemCount, 2);
  assert.equal(batch.items.length, 2);
  assert(!/latitude|longitude/i.test(JSON.stringify(batch)), "一括JSONに生の位置情報名が含まれています");

  const [csvDownload] = await Promise.all([
    page.waitForEvent("download"),
    page.locator("#exportCsvButton").click()
  ]);
  const csvPath = await csvDownload.path();
  assert(csvPath, "一括CSVを取得できませんでした");
  const csv = await fs.readFile(csvPath, "utf8");
  assert(csv.startsWith("\uFEFF"), "CSVにUTF-8 BOMがありません");
  assert(csv.includes("'=batch-two.jpg"), "CSV数式注入対策が働いていません");
  assert(!/latitude|longitude/i.test(csv), "CSVに生の位置情報名が含まれています");

  await page.locator("#startButton").click();
  await page.waitForFunction(() => document.querySelectorAll('.result-item[data-status="success"]').length === 2, null, { timeout: 60000 });
  assert.equal(await page.locator("#downloadAllButton").isEnabled(), true);

  const firstDownloadPromise = page.waitForEvent("download");
  await page.locator("#downloadAllButton").click();
  const firstDownload = await firstDownloadPromise;
  assert(await firstDownload.path(), "完了画像の順次保存を開始できませんでした");

  await page.getByRole("button", { name: "設定を変えて再処理" }).first().click();
  await page.waitForFunction(() => document.querySelector('.result-item[data-status="waiting"]'));
  assert.equal(await page.locator("#startButton").isEnabled(), true);

  await page.locator("#resetButton").click();
  await page.waitForFunction(() => document.querySelectorAll(".result-item").length === 0);
}

async function setExifJpeg(page) {
  await page.evaluate(async () => {
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
      return Uint8Array.from(Array.from(value, (character) => character.charCodeAt(0)));
    }

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

    const canvas = document.createElement("canvas");
    canvas.width = 96;
    canvas.height = 72;
    const context = canvas.getContext("2d");
    context.fillStyle = "#143b73";
    context.fillRect(0, 0, 96, 72);
    context.fillStyle = "#ffbe46";
    context.fillRect(24, 18, 48, 36);
    const baseBlob = await new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.92));
    if (!baseBlob) throw new Error("Exif監査画像を作成できません");
    const baseBytes = new Uint8Array(await baseBlob.arrayBuffer());
    const withExif = concat(baseBytes.subarray(0, 2), app1, baseBytes.subarray(2));
    const file = new File([withExif], "gps-source.jpg", { type: "image/jpeg", lastModified: 1700000000000 });
    const transfer = new DataTransfer();
    transfer.items.add(file);
    const input = document.querySelector("#fileInput");
    input.files = transfer.files;
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

async function waitForReadyItems(page, count) {
  await page.waitForFunction(
    (expected) => {
      const items = Array.from(document.querySelectorAll(".result-item"));
      return items.length === expected && items.every((item) => item.dataset.status === "waiting");
    },
    count,
    { timeout: 30000 }
  );
}

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { chromium } from "@playwright/test";

const targets = [
  {
    name: "変更ブランチ",
    url: process.env.AUDIT_LOCAL_URL || "http://127.0.0.1:8000/",
    requireDisclaimer: true,
    requireMinimalCsp: true,
    requireBatchExports: true,
    requireGlobalDrop: true
  },
  {
    name: "公開サイト",
    url: process.env.AUDIT_LIVE_URL || "https://abcderp2.github.io/Exif/",
    requireDisclaimer: true,
    requireMinimalCsp: false,
    requireBatchExports: false,
    requireGlobalDrop: false
  }
];

const browser = await chromium.launch({ headless: true });

try {
  for (const target of targets) await auditTarget(target);
} finally {
  await browser.close();
}

async function auditTarget(target) {
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
  const expectedOrigin = new URL(target.url).origin;

  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  page.on("pageerror", (error) => pageErrors.push(String(error)));
  page.on("requestfailed", (request) => failedRequests.push(`${request.method()} ${request.url()} ${request.failure()?.errorText || ""}`));
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (["http:", "https:"].includes(url.protocol) && url.origin !== expectedOrigin) outsideRequests.push(request.url());
  });

  const response = await page.goto(target.url, { waitUntil: "networkidle", timeout: 60000 });
  assert(response?.ok(), `${target.name}を開けませんでした`);
  assert.equal(await page.title(), "画像メタデータクリーナー");
  assert.equal(await page.locator("#dropZone").isEnabled(), true);

  const csp = await page.locator('meta[http-equiv="Content-Security-Policy"]').getAttribute("content");
  assert(csp?.includes("connect-src 'none'"), `${target.name}のCSPで外部通信が禁止されていません`);
  assert(csp?.includes("object-src 'none'"), `${target.name}のCSPでobjectが禁止されていません`);

  if (target.requireMinimalCsp) {
    assert(csp?.includes("img-src 'self' blob:"), `${target.name}のCSPで画像の許可範囲を確認できません`);
    assert(!csp?.includes("img-src 'self' blob: data:"), `${target.name}のCSPが不要なdata URL画像を許可しています`);
    assert(csp?.includes("worker-src 'self'"), `${target.name}のCSPでWorkerの許可範囲を確認できません`);
    assert(!csp?.includes("worker-src 'self' blob:"), `${target.name}のCSPが不要なblob Workerを許可しています`);
    assert(csp?.includes("media-src 'none'"), `${target.name}のCSPで不要なメディア読込が禁止されていません`);
  }

  if (target.requireDisclaimer) {
    const bodyText = await page.locator("body").innerText();
    assert(bodyText.includes("一切保証しません"), "サイトに無保証の記載がありません");
    assert(bodyText.includes("自己の責任"), "利用者自身の判断と責任の記載がありません");
  }

  if (target.requireBatchExports) await assertNoHorizontalOverflow(page, 280, 720, `${target.name} 最小幅`);
  await assertNoHorizontalOverflow(page, 320, 720, `${target.name} 小型スマートフォン`);
  await assertNoHorizontalOverflow(page, 360, 780, `${target.name} スマートフォン`);
  await assertNoHorizontalOverflow(page, 768, 1024, `${target.name} タブレット`);
  await assertNoHorizontalOverflow(page, 1024, 768, `${target.name} タブレット横向き`);
  await assertNoHorizontalOverflow(page, 1440, 900, `${target.name} パソコン`);
  await page.setViewportSize({ width: 360, height: 780 });

  await testInvalidFile(page);
  if (target.requireGlobalDrop) await testGlobalDrop(page);
  await testInputDetection(page);
  if (target.requireBatchExports) await testBatchExports(page);
  await testConversions(page);
  await testLowEndScaling(page, target.requireBatchExports ? 4_000_000 : 8_000_000);

  assert.deepEqual(outsideRequests, [], `${target.name}が外部へ通信しました: ${outsideRequests.join(", ")}`);
  assert.deepEqual(failedRequests, [], `${target.name}で通信失敗が発生しました: ${failedRequests.join(", ")}`);
  assert.deepEqual(pageErrors, [], `${target.name}でJavaScript例外が発生しました: ${pageErrors.join(" | ")}`);
  assert.deepEqual(consoleErrors, [], `${target.name}でconsole.errorが発生しました: ${consoleErrors.join(" | ")}`);

  await context.close();
  console.log(`${target.name}のブラウザ監査に合格しました`);
}

async function assertNoHorizontalOverflow(page, width, height, label) {
  await page.setViewportSize({ width, height });
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  assert(overflow <= 1, `${label}で横方向に${overflow}pxはみ出しています`);
}

async function testInvalidFile(page) {
  await setRawFile(page, {
    name: "not-an-image.jpg",
    type: "image/jpeg",
    bytes: Array.from(new TextEncoder().encode("not an image"))
  });
  await page.waitForFunction(() => document.querySelector("#queueStatus")?.textContent?.includes("JPEG、PNG、WebPとして確認できません"));
  assert.equal(await page.locator(".result-item").count(), 0);
}

async function testGlobalDrop(page) {
  await page.evaluate(async () => {
    const canvas = document.createElement("canvas");
    canvas.width = 40;
    canvas.height = 30;
    const context = canvas.getContext("2d");
    context.fillStyle = "#143b73";
    context.fillRect(0, 0, 40, 30);
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
    const file = new File([blob], "dropped.png", { type: "image/png", lastModified: 1700000000000 });
    const transfer = new DataTransfer();
    transfer.items.add(file);
    document.body.dispatchEvent(new DragEvent("dragenter", { bubbles: true, cancelable: true, dataTransfer: transfer }));
    if (document.querySelector("#dropOverlay")?.hidden) throw new Error("ドラッグ表示が開きませんでした");
    document.body.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: transfer }));
  });
  await waitForReadyItems(page, 1);
  assert.equal(await page.locator("#dropOverlay").isHidden(), true);
  await page.locator("#resetButton").click();
  await page.waitForFunction(() => document.querySelectorAll(".result-item").length === 0);
}

async function testInputDetection(page) {
  const inputs = [
    ["image/jpeg", "source.jpg"],
    ["image/png", "source.png"],
    ["image/webp", "source.webp"]
  ];

  for (let index = 0; index < inputs.length; index += 1) {
    const [mime, name] = inputs[index];
    await setCanvasFile(page, { mime, name, width: 32, height: 24, alpha: mime !== "image/jpeg" });
    await waitForReadyItems(page, index + 1);
  }

  const labels = await page.locator(".result-meta").allTextContents();
  assert(labels.some((text) => text.includes("JPEG")), "JPEG入力を認識できませんでした");
  assert(labels.some((text) => text.includes("PNG")), "PNG入力を認識できませんでした");
  assert(labels.some((text) => text.includes("WebP")), "WebP入力を認識できませんでした");

  await page.locator("#resetButton").click();
  await page.waitForFunction(() => document.querySelectorAll(".result-item").length === 0);
}

async function testBatchExports(page) {
  await setCanvasFiles(page, [
    { mime: "image/png", name: "batch-one.png", width: 48, height: 36, alpha: true },
    { mime: "image/jpeg", name: "=batch-two.jpg", width: 48, height: 36, alpha: false }
  ]);
  await waitForReadyItems(page, 2);

  const [jsonDownload] = await Promise.all([
    page.waitForEvent("download"),
    page.locator("#exportJsonButton").click()
  ]);
  const jsonPath = await jsonDownload.path();
  assert(jsonPath, "一括JSONを取得できませんでした");
  const batch = JSON.parse(await fs.readFile(jsonPath, "utf8"));
  assert.equal(batch.itemCount, 2);
  assert.equal(batch.items.length, 2);
  assert.equal(JSON.stringify(batch).includes("latitude"), false);
  assert.equal(JSON.stringify(batch).includes("longitude"), false);

  const [csvDownload] = await Promise.all([
    page.waitForEvent("download"),
    page.locator("#exportCsvButton").click()
  ]);
  const csvPath = await csvDownload.path();
  assert(csvPath, "一括CSVを取得できませんでした");
  const csv = await fs.readFile(csvPath, "utf8");
  assert(csv.startsWith("\uFEFF"), "CSVにUTF-8 BOMがありません");
  assert(csv.includes("処理後検査"), "CSVの見出しが不足しています");
  assert(csv.includes("'=batch-two.jpg"), "CSV数式注入対策が働いていません");
  assert(!/latitude|longitude/i.test(csv), "CSVに生の位置情報名が含まれています");

  await page.locator("#startButton").click();
  await page.waitForFunction(() => document.querySelectorAll('.result-item[data-status="success"]').length === 2, null, { timeout: 60000 });
  await page.locator("#resetButton").click();
  await page.waitForFunction(() => document.querySelectorAll(".result-item").length === 0);
}

async function testConversions(page) {
  const outputs = [
    { key: "jpeg", mime: "image/jpeg", extension: ".jpg", magic: [0xff, 0xd8, 0xff] },
    { key: "png", mime: "image/png", extension: ".png", magic: [0x89, 0x50, 0x4e, 0x47] },
    { key: "webp", mime: "image/webp", extension: ".webp", magic: [0x52, 0x49, 0x46, 0x46] }
  ];

  for (const output of outputs) {
    const option = page.locator(`#outputFormatSelect option[value="${output.key}"]`);
    if (await option.isDisabled()) continue;
    await page.locator("#outputFormatSelect").selectOption(output.key);
    await setCanvasFile(page, { mime: "image/png", name: `convert-to-${output.key}.png`, width: 64, height: 48, alpha: true });
    await waitForReadyItems(page, 1);
    await page.locator("#startButton").click();
    await page.waitForFunction(() => document.querySelector('.result-item[data-status="success"]'));

    const successText = await page.locator(".success-message").innerText();
    assert(successText.includes("個人情報領域がないことを確認"));

    const [imageDownload] = await Promise.all([
      page.waitForEvent("download"),
      page.locator("a.result-action.primary").click()
    ]);
    assert(imageDownload.suggestedFilename().endsWith(output.extension));
    const imagePath = await imageDownload.path();
    assert(imagePath, "変換画像を取得できませんでした");
    const imageBytes = await fs.readFile(imagePath);
    assert(imageBytes.length > 16, "変換画像が空です");
    assert.deepEqual(Array.from(imageBytes.subarray(0, output.magic.length)), output.magic);

    const [reportDownload] = await Promise.all([
      page.waitForEvent("download"),
      page.getByRole("button", { name: /JSON分析結果|分析結果を保存/ }).first().click()
    ]);
    const reportPath = await reportDownload.path();
    assert(reportPath, "分析結果を取得できませんでした");
    const report = JSON.parse(await fs.readFile(reportPath, "utf8"));
    assert.equal(report.output.type, output.mime);
    assert.equal(report.output.metadataCheckPassed, true);
    assert.equal(JSON.stringify(report).includes("latitude"), false);
    assert.equal(JSON.stringify(report).includes("longitude"), false);

    await page.getByRole("button", { name: "設定を変えて再処理" }).click();
    await page.waitForFunction(() => document.querySelector('.result-item[data-status="waiting"]'));
    assert.equal(await page.locator("#startButton").isEnabled(), true);

    await page.locator("#resetButton").click();
    await page.waitForFunction(() => document.querySelectorAll(".result-item").length === 0);
  }
}

async function testLowEndScaling(page, expectedPixelLimit) {
  await page.locator("#outputFormatSelect").selectOption("png");
  await page.locator("#largeImageSelect").selectOption("safe");
  await setCanvasFile(page, { mime: "image/png", name: "large.png", width: 3000, height: 3000, alpha: false });
  await waitForReadyItems(page, 1);
  await page.locator("#startButton").click();
  await page.waitForFunction(() => document.querySelector('.result-item[data-status="success"]'), null, { timeout: 60000 });

  const warning = await page.locator(".result-warning").innerText();
  assert(warning.includes("端末の安全上限に合わせて縮小"), "低性能端末向けの縮小が行われませんでした");
  const caption = await page.locator("#previewCaption").innerText();
  const match = caption.match(/(\d+) × (\d+)/);
  assert(match, "処理後の大きさを確認できませんでした");
  assert(Number(match[1]) * Number(match[2]) <= expectedPixelLimit, "低性能端末向けの画素上限を超えています");

  await page.locator("#resetButton").click();
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

async function setCanvasFile(page, options) {
  await setCanvasFiles(page, [options]);
}

async function setCanvasFiles(page, optionsList) {
  await page.evaluate(async (allOptions) => {
    const transfer = new DataTransfer();
    for (const { mime, name, width, height, alpha } of allOptions) {
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const context = canvas.getContext("2d");
      context.fillStyle = "#143b73";
      context.fillRect(0, 0, width, height);
      context.fillStyle = alpha ? "rgba(255, 190, 70, 0.45)" : "rgb(255, 190, 70)";
      context.fillRect(Math.floor(width / 4), Math.floor(height / 4), Math.floor(width / 2), Math.floor(height / 2));
      const blob = await new Promise((resolve) => canvas.toBlob(resolve, mime, 0.92));
      if (!blob || blob.type !== mime) throw new Error(`${mime}のテスト画像を作成できません`);
      transfer.items.add(new File([blob], name, { type: mime, lastModified: 1700000000000 }));
    }
    const input = document.querySelector("#fileInput");
    input.files = transfer.files;
    input.dispatchEvent(new Event("change", { bubbles: true }));
  }, optionsList);
}

async function setRawFile(page, { name, type, bytes }) {
  await page.evaluate(({ name, type, bytes }) => {
    const file = new File([Uint8Array.from(bytes)], name, { type, lastModified: 1700000000000 });
    const transfer = new DataTransfer();
    transfer.items.add(file);
    const input = document.querySelector("#fileInput");
    input.files = transfer.files;
    input.dispatchEvent(new Event("change", { bubbles: true }));
  }, { name, type, bytes });
}

import assert from "node:assert/strict";
import { chromium } from "@playwright/test";

const target = process.env.AUDIT_LOCAL_URL || "http://127.0.0.1:8000/";
const browser = await chromium.launch({ headless: true });

try {
  const page = await browser.newPage({ viewport: { width: 360, height: 780 } });
  const response = await page.goto(target, { waitUntil: "networkidle", timeout: 60000 });
  assert(response?.ok(), "監査対象ページを開けませんでした");

  const unnamed = await page.locator("input, select, textarea").evaluateAll((controls) => controls
    .filter((element) => !(element instanceof HTMLInputElement && element.type === "hidden"))
    .filter((element) => {
      if (element.getAttribute("aria-label")?.trim()) return false;
      const labelledBy = element.getAttribute("aria-labelledby");
      if (labelledBy) {
        const text = labelledBy.split(/\s+/).map((id) => document.getElementById(id)?.textContent || "").join(" ").trim();
        if (text) return false;
      }
      if (element.labels && Array.from(element.labels).some((label) => label.textContent?.trim())) return false;
      return true;
    })
    .map((element) => `${element.tagName.toLowerCase()}#${element.id || "no-id"}`));

  assert.deepEqual(unnamed, [], `アクセシブルネームのないフォーム部品があります: ${unnamed.join(", ")}`);

  const describedBy = new Set(((await page.locator("#fileInput").getAttribute("aria-describedby")) || "").split(/\s+/).filter(Boolean));
  assert(describedBy.has("uploadHelp"));
  assert(describedBy.has("uploadLimits"));

  const skip = page.locator('a[href="#main"]');
  assert.equal(await skip.count(), 1);
  await skip.focus();
  assert.equal(await skip.isVisible(), true);

  console.log("Accessibility audit: PASSED");
} finally {
  await browser.close();
}

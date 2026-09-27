import assert from "node:assert/strict";
import { chromium } from "playwright";

const target = process.argv[2] || "http://127.0.0.1:5173/";
const browser = await chromium.launch({
  headless: true,
  args: ["--no-sandbox", "--use-gl=swiftshader", "--enable-webgl"],
});
const page = await browser.newPage({
  viewport: { width: 1440, height: 900 },
  ignoreHTTPSErrors: true,
});
const errors = [];
page.on("pageerror", (error) => errors.push(String(error)));

try {
  await page.goto(target, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(
    () =>
      document.querySelector(".map-mode")?.textContent?.trim() === "STREET MAP",
    null,
    { timeout: 35000 },
  );
  await page.screenshot({ path: "/tmp/recovery-street-overview.png" });
  await page.getByRole("button", { name: "Tilt view" }).click();
  await page.waitForTimeout(700);
  await page.screenshot({ path: "/tmp/recovery-street-overview-tilted.png" });
  await page.getByRole("button", { name: "Top-down" }).click();
  await page.getByRole("button", { name: "Unit 01", exact: true }).click();
  await page.waitForTimeout(850);
  await page
    .locator("#globe canvas")
    .first()
    .hover({ position: { x: 420, y: 280 } });
  for (let index = 0; index < 3; index++) {
    await page.mouse.wheel(0, -620);
    await page.waitForTimeout(300);
  }
  await page.waitForTimeout(2500);
  assert.equal(await page.locator(".map-mode").innerText(), "STREET MAP");
  await page.screenshot({ path: "/tmp/recovery-street-fifth-close.png" });
  await page.getByRole("button", { name: "Tilt view" }).click();
  await page.waitForTimeout(1600);
  await page.screenshot({
    path: "/tmp/recovery-street-fifth-close-tilted.png",
  });
  assert.deepEqual(errors, []);
  console.log(
    "Street overview and Fifth Street close views captured in both angles.",
  );
} finally {
  await browser.close();
}

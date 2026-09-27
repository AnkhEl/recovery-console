import assert from "node:assert/strict";
import { chromium } from "playwright";

const url = process.argv[2] ?? "http://127.0.0.1:5173/?scenarioSeed=27";
const browser = await chromium.launch({
  headless: true,
  args: ["--no-sandbox", "--use-gl=swiftshader", "--enable-webgl"],
});
const page = await browser.newPage({
  viewport: { width: 1600, height: 950 },
  ignoreHTTPSErrors: true,
});
const errors = [];
page.on("pageerror", (error) => errors.push(String(error)));
await page.goto(url, { waitUntil: "domcontentloaded" });
await page
  .getByRole("combobox", { name: "Unit 02 objective" })
  .selectOption("junction-7");
await page.getByRole("button", { name: "Assign and move Unit 02" }).click();
const slider = page.getByRole("slider", { name: "Scenario time in seconds" });
await slider.fill("55");
const before = await page.locator(".location-box strong").innerText();
await slider.fill("63");
assert.equal(await page.locator(".location-box strong").innerText(), before);
assert.match(
  await page.locator(".vehicle-card").innerText(),
  /Device report time\s*14:32:55 SAST/,
);
assert.match(
  await page.locator(".observation-overlay").innerText(),
  /Observed at 01:01; available at 01:03/,
);
assert.match(
  await page.locator(".observation-overlay").innerText(),
  /GPS remains at its last confirmed report/,
);
assert.match(
  await page.locator(".activity").innerText(),
  /simulated observation/i,
);
await page.screenshot({
  path: "/tmp/recovery-observation-outage.png",
  fullPage: true,
});
assert.deepEqual(errors, []);
console.log("Observation during GPS loss browser review passed", {
  lastConfirmed: before,
});
await browser.close();

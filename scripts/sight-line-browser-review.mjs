import assert from "node:assert/strict";
import { chromium } from "playwright";

const base = process.argv[2] ?? "http://127.0.0.1:5173/";
const browser = await chromium.launch({
  headless: true,
  args: ["--no-sandbox", "--use-gl=swiftshader", "--enable-webgl"],
});
const errors = [];

for (const fixture of ["clear", "blocked"]) {
  const page = await browser.newPage({
    viewport: { width: 1500, height: 950 },
    ignoreHTTPSErrors: true,
  });
  page.on("pageerror", (error) => errors.push(String(error)));
  const url = new URL(base);
  url.searchParams.set("scenarioSeed", "413");
  url.searchParams.set("sightLineFixture", fixture);
  await page.goto(url.toString(), {
    waitUntil: "domcontentloaded",
    timeout: 90000,
  });
  await page
    .getByRole("combobox", { name: "Unit 02 objective" })
    .selectOption("junction-7");
  await page.getByRole("button", { name: "Assign and move Unit 02" }).click();
  const slider = page.getByRole("slider", { name: "Scenario time in seconds" });
  await slider.fill("55");
  const before = await page.locator(".location-box strong").innerText();
  await slider.fill("64");
  assert.equal(await page.locator(".location-box strong").innerText(), before);
  assert.match(
    await page.locator(".signal-overlay").innerText(),
    /last confirmed/i,
  );
  assert.match(
    await page.locator(".sight-line-fixture-label").innerText(),
    new RegExp(`Synthetic sight-line fixture.*${fixture}`),
  );
  assert.equal(
    await page
      .getByRole("button", { name: "Mapped building footprints" })
      .getAttribute("aria-pressed"),
    "true",
  );
  await page.waitForFunction(
    () => document.querySelector("#globe")?.__recoveryViewer,
  );
  const mappedFixture = await page
    .locator("#globe")
    .evaluate((host) =>
      Boolean(
        host.__recoveryViewer.entities.getById(
          "mapped-footprint-synthetic-sight-line-screen",
        ),
      ),
    );
  assert.equal(mappedFixture, fixture === "blocked");
  if (fixture === "clear") {
    assert.match(
      await page.locator(".observation-overlay").innerText(),
      /Observed at 01:02; available at 01:04/,
    );
    assert.match(
      await page.locator(".observation-overlay").innerText(),
      /actual visibility uncertain/i,
    );
    assert.match(
      await page.locator(".activity").innerText(),
      /simulated observation/i,
    );
  } else {
    assert.equal(await page.locator(".observation-overlay").count(), 0);
    assert.doesNotMatch(
      await page.locator(".activity").innerText(),
      /Unit 02 simulated observation at Fredman Drive × Sandown Valley Crescent/i,
    );
  }
  await page.screenshot({
    path: `/tmp/recovery-sight-line-${fixture}.png`,
    fullPage: true,
  });
  await page.close();
}

const mobile = await browser.newPage({
  viewport: { width: 390, height: 844 },
  ignoreHTTPSErrors: true,
});
mobile.on("pageerror", (error) => errors.push(String(error)));
const mobileUrl = new URL(base);
mobileUrl.searchParams.set("scenarioSeed", "413");
mobileUrl.searchParams.set("sightLineFixture", "blocked");
await mobile.goto(mobileUrl.toString(), {
  waitUntil: "domcontentloaded",
  timeout: 90000,
});
assert.equal(
  await mobile.evaluate(
    () => document.documentElement.scrollWidth <= window.innerWidth,
  ),
  true,
);
assert.equal(
  await mobile
    .getByRole("button", { name: "Mapped building footprints" })
    .count(),
  1,
);
await mobile.screenshot({
  path: "/tmp/recovery-sight-line-mobile.png",
  fullPage: true,
});
await mobile.close();

assert.deepEqual(errors, []);
console.log("Sight-line clear and blocked browser fixtures passed");
await browser.close();

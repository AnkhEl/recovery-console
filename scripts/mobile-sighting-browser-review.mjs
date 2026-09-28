import assert from "node:assert/strict";
import { chromium } from "playwright";

const base = process.argv[2] ?? "http://127.0.0.1:5174/";
const browser = await chromium.launch({
  headless: true,
  args: ["--no-sandbox", "--use-gl=swiftshader", "--enable-webgl"],
});
const errors = [];
for (const [fixture, beforeSecond, availableSecond, mode] of [
  ["oncoming-clear", 5, 6, "oncoming"],
  ["following-clear", 3, 4, "following"],
  ["oncoming-fleeting", 5, 19, null],
]) {
  const page = await browser.newPage({
    viewport: { width: 1500, height: 950 },
    ignoreHTTPSErrors: true,
  });
  page.on("pageerror", (error) => errors.push(String(error)));
  const url = new URL(base);
  url.searchParams.set("scenarioSeed", "4");
  url.searchParams.set("mobileFixture", fixture);
  await page.goto(url.toString(), {
    waitUntil: "domcontentloaded",
    timeout: 90000,
  });
  await page
    .getByRole("combobox", { name: "Unit 02 objective" })
    .selectOption("junction-1");
  await page.getByRole("button", { name: "Assign and move Unit 02" }).click();
  const slider = page.getByRole("slider", { name: "Scenario time in seconds" });
  await slider.fill(String(beforeSecond));
  const lastConfirmed = await page.locator(".location-box strong").innerText();
  assert.equal(await page.locator(".mobile-observation-overlay").count(), 0);
  await slider.fill(String(availableSecond));
  assert.equal(
    await page.locator(".location-box strong").innerText(),
    lastConfirmed,
  );
  assert.match(
    await page.locator(".signal-overlay").innerText(),
    /last confirmed/i,
  );
  assert.match(
    await page.locator(".mobile-fixture-label").innerText(),
    new RegExp(fixture.replaceAll("-", " ")),
  );
  if (mode) {
    const expected =
      mode === "oncoming"
        ? /Observed at 00:04; available at 00:06/
        : /Observed at 00:02; available at 00:04/;
    assert.match(
      await page.locator(".mobile-observation-overlay").innerText(),
      expected,
    );
    assert.match(
      await page.locator(".activity").innerText(),
      /simulated mobile sighting/i,
    );
    await page.waitForFunction(
      () => document.querySelector("#globe")?.__recoveryViewer,
    );
    assert.equal(
      await page
        .locator("#globe")
        .evaluate(
          (host, kind) =>
            Boolean(
              host.__recoveryViewer.entities.getById(
                `mobile-observation-unit-2-${kind}-${kind === "oncoming" ? 4 : 2}`,
              ),
            ),
          mode,
        ),
      true,
    );
    await slider.fill("1");
    assert.equal(await page.locator(".mobile-observation-overlay").count(), 0);
    await slider.fill(String(availableSecond));
    assert.match(
      await page.locator(".mobile-observation-overlay").innerText(),
      expected,
    );
  } else {
    assert.equal(await page.locator(".mobile-observation-overlay").count(), 0);
    assert.doesNotMatch(
      await page.locator(".activity").innerText(),
      /mobile sighting/i,
    );
  }
  await page.screenshot({
    path: `/tmp/recovery-mobile-${fixture}.png`,
    fullPage: true,
  });
  await page.close();
}
assert.deepEqual(errors, []);
console.log("Oncoming, following, and negative mobile browser fixtures passed");
await browser.close();

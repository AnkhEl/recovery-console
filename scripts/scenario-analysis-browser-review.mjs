import assert from "node:assert/strict";
import { chromium } from "playwright";

const url = process.argv[2] ?? "http://127.0.0.1:5174/?scenarioSeed=27";
const browser = await chromium.launch({
  headless: true,
  args: ["--no-sandbox"],
});
try {
  const page = await browser.newPage({
    viewport: { width: 1600, height: 950 },
    ignoreHTTPSErrors: true,
  });
  const errors = [];
  page.on("pageerror", (error) => errors.push(String(error)));
  await page.goto(url, { waitUntil: "domcontentloaded" });
  const analysis = page.getByRole("region", { name: "Scenario analysis" });
  await analysis
    .getByRole("button", { name: /Review (assign|retask)/ })
    .first()
    .waitFor();
  assert.match(await analysis.innerText(), /Transparent baseline alternatives/);
  assert.doesNotMatch(await analysis.innerText(), /probability|AI-generated/i);
  const optionCount = await analysis
    .getByRole("button", { name: /Review (assign|retask)/ })
    .count();
  assert(optionCount > 0 && optionCount <= 3);

  await analysis
    .getByRole("button", { name: /Review (assign|retask)/ })
    .first()
    .click();
  const review = page.getByRole("dialog", {
    name: "Review scenario analysis option",
  });
  await review.waitFor();
  assert.equal(await page.locator(".activity-operator_action").count(), 0);
  await page.waitForTimeout(1100);
  await review.getByRole("button", { name: "Confirm simulated order" }).click();
  assert.equal(await review.count(), 0);
  assert.match(
    await page.locator(".activity-operator_action").first().innerText(),
    /simulation only/,
  );

  await page.getByRole("button", { name: "Reset scenario" }).click();
  const slider = page.getByRole("slider", { name: "Scenario time in seconds" });
  await slider.fill("63");
  assert.match(await analysis.innerText(), /Transparent baseline alternatives/);
  assert(
    (await analysis
      .getByRole("button", { name: /Review (assign|retask)/ })
      .count()) > 0,
  );
  await slider.fill("86");
  assert.match(await analysis.innerText(), /No eligible alternatives/);

  await slider.fill("63");
  await analysis
    .getByRole("button", { name: /Review (assign|retask)/ })
    .first()
    .click();
  await slider.fill("64", { force: true });
  await review.getByRole("button", { name: "Confirm simulated order" }).click();
  assert.match(await review.innerText(), /Replay information changed/);
  assert.equal(await page.locator(".activity-operator_action").count(), 0);
  await review.getByRole("button", { name: "Confirm simulated order" }).click();
  assert.equal(await review.count(), 0);
  assert.equal(await page.locator(".activity-operator_action").count(), 1);

  await page.getByRole("button", { name: "Reset scenario" }).click();
  await slider.fill("60");
  await analysis
    .getByRole("button", { name: /Review (assign|retask)/ })
    .first()
    .click();
  await review.getByRole("button", { name: "Confirm simulated order" }).click();
  await slider.fill("0");
  await analysis
    .getByRole("button", { name: /Review (assign|retask)/ })
    .first()
    .click();
  assert.match(await review.innerText(), /creates an alternative run/);
  await review.getByRole("button", { name: "Confirm simulated order" }).click();
  const runs = page.getByRole("combobox", { name: "Scenario run" });
  assert.equal(await runs.locator("option").count(), 2);
  assert.match(await runs.inputValue(), /run-2/);
  assert.deepEqual(errors, []);
  console.log("Scenario analysis browser review passed", { optionCount });
} finally {
  await browser.close();
}

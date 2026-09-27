import assert from "node:assert/strict";
import { chromium } from "playwright";

const url = process.argv[2] ?? "http://127.0.0.1:5173/";
const browser = await chromium.launch({
  headless: true,
  args: ["--no-sandbox", "--use-gl=swiftshader", "--enable-webgl"],
});
try {
  const page = await browser.newPage({
    viewport: { width: 1600, height: 950 },
    ignoreHTTPSErrors: true,
  });
  const errors = [];
  page.on("pageerror", (error) => errors.push(String(error)));
  await page.goto(url, { waitUntil: "domcontentloaded" });
  await page.getByRole("combobox", { name: "Unit 03 objective" }).waitFor();
  await page
    .getByRole("combobox", { name: "Unit 03 objective" })
    .selectOption("junction-3");
  await page.getByRole("button", { name: "Assign and move Unit 03" }).click();
  await page.getByRole("button", { name: "Play scenario" }).click();
  const samples = await page.evaluate(
    () =>
      new Promise((resolve) => {
        const slider = document.querySelector(
          'input[aria-label="Scenario time in seconds"]',
        );
        if (!slider) throw new Error("Scenario time slider missing");
        const values = [];
        const started = performance.now();
        const interval = setInterval(() => {
          values.push(Number(slider.value));
          if (performance.now() - started >= 12500) {
            clearInterval(interval);
            resolve(values);
          }
        }, 25);
      }),
  );
  await page.getByRole("button", { name: "Pause scenario" }).click();
  for (let index = 1; index < samples.length; index++) {
    assert.ok(
      samples[index] >= samples[index - 1],
      `Replay clock reversed at sample ${index}: ${samples[index - 1]} → ${samples[index]}`,
    );
  }
  assert.ok(samples.at(-1) >= 10, `Replay advanced only to ${samples.at(-1)}s`);
  assert.deepEqual(errors, []);
  console.log("Replay clock remained monotonic across report boundaries", {
    start: samples[0],
    end: samples.at(-1),
    samples: samples.length,
  });
} finally {
  await browser.close();
}

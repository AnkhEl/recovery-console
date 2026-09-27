import assert from "node:assert/strict";
import { chromium } from "playwright";

const target = process.argv[2] || "http://127.0.0.1:5173/";
const count = Number(process.argv[3] || 3);
const launchOptions = {
  headless: true,
  args: ["--no-sandbox", "--use-gl=swiftshader", "--enable-webgl"],
};

async function newPage() {
  const browser = await chromium.launch(launchOptions);
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    ignoreHTTPSErrors: true,
    serviceWorkers: "block",
  });
  return { browser, page: await context.newPage() };
}

async function waitForMapResult(page) {
  await page.waitForFunction(
    () =>
      ["STREET MAP", "AERIAL MAP", "ILLUSTRATIVE VIEW"].includes(
        document.querySelector(".map-mode")?.textContent?.trim(),
      ),
    null,
    { timeout: 35000 },
  );
  return page.locator(".map-mode").innerText();
}

for (let attempt = 1; attempt <= count; attempt++) {
  const { browser, page } = await newPage();
  const streetTiles = [];
  const errors = [];
  page.on("pageerror", (error) => errors.push(String(error)));
  page.on("response", (response) => {
    if (response.url().startsWith("https://tile.openstreetmap.org/"))
      streetTiles.push({ url: response.url(), status: response.status() });
  });
  try {
    await page.goto(target, { waitUntil: "domcontentloaded" });
    const mode = await waitForMapResult(page);
    const highestLevel = Math.max(
      0,
      ...streetTiles
        .filter((tile) => tile.status === 200)
        .map((tile) => Number(new URL(tile.url).pathname.split("/")[1])),
    );
    console.log("fresh load", attempt, {
      mode,
      highestLevel,
      tileCount: streetTiles.length,
    });
    await page.screenshot({
      path: `/tmp/recovery-parity-fresh-${attempt}.png`,
    });
    assert.equal(mode, "STREET MAP");
    assert(highestLevel >= 12);
    assert.equal(await page.locator(".schematic").count(), 0);
    assert.match(
      await page.locator(".cesium-viewer-bottom").innerText(),
      /OpenStreetMap/,
    );
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
  }
}

const { browser, page } = await newPage();
const aerialTiles = [];
const errors = [];
let streetRequests = 0;
let releasePendingStreet;
const pendingStreet = new Promise(
  (resolve) => (releasePendingStreet = resolve),
);
page.on("pageerror", (error) => errors.push(String(error)));
page.on("response", (response) => {
  if (response.url().includes("World_Imagery"))
    aerialTiles.push(response.status());
});
await page.route("https://tile.openstreetmap.org/**", async (route) => {
  streetRequests++;
  if (streetRequests === 1) {
    await pendingStreet;
  }
  await route.abort().catch(() => {});
});
try {
  await page.goto(target, { waitUntil: "domcontentloaded" });
  assert.equal(await waitForMapResult(page), "ILLUSTRATIVE VIEW");
  assert.match(
    await page.locator(".schematic-label").innerText(),
    /Illustrative diagram/,
  );
  assert.match(
    await page.locator(".map-message").innerText(),
    /Street map tiles unavailable/,
  );
  await page.screenshot({ path: "/tmp/recovery-parity-street-failure.png" });
  await page.getByRole("button", { name: /Aerial map/ }).click();
  assert.equal(await waitForMapResult(page), "AERIAL MAP");
  assert.equal(await page.locator(".schematic").count(), 0);
  assert(aerialTiles.includes(200));
  assert.match(await page.locator(".cesium-viewer-bottom").innerText(), /Esri/);
  assert.deepEqual(errors, []);
  await page.screenshot({ path: "/tmp/recovery-parity-aerial-recovery.png" });
  console.log("street failure and aerial recovery passed", {
    streetRequests,
    aerialTiles: aerialTiles.length,
  });
} finally {
  releasePendingStreet();
  await browser.close();
}

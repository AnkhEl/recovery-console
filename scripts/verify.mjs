import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
const pkg = JSON.parse(readFileSync("package.json", "utf8"));
assert(pkg.dependencies.cesium, "Cesium must be package-managed");
for (const file of [
  "index.html",
  "src/main.tsx",
  "src/model.ts",
  "src/scenario.ts",
  "src/components/CesiumMap.tsx",
  "public/route.json",
  "vite.config.ts",
  "package-lock.json",
])
  assert(existsSync(file), `Missing ${file}`);
assert(
  JSON.parse(readFileSync("public/route.json", "utf8")).coordinates.length > 2,
);
assert(existsSync("public/CESIUM-LICENSE.md"));
assert(existsSync("public/CESIUM-THIRD-PARTY.json"));
assert(!existsSync("dist"));
console.log("PASS: package-managed Cesium, source, route, and lockfile.");

import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { viteStaticCopy } from "vite-plugin-static-copy";

const cesiumSource = "node_modules/cesium/Build/Cesium";
const cesiumBaseUrl = "cesiumStatic";
export default defineConfig({
  plugins: [
    react(),
    viteStaticCopy({
      targets: ["Workers", "ThirdParty", "Assets", "Widgets"].map((name) => ({
        src: `${cesiumSource}/${name}`,
        dest: cesiumBaseUrl,
      })),
    }),
  ],
  define: { CESIUM_BASE_URL: JSON.stringify(`/${cesiumBaseUrl}/`) },
  build: { outDir: "build" },
});

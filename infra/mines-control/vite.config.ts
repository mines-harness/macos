import "vite-plus/test/config";
import { defineConfig } from "vite-plus";
import baseConfig from "../../vite.config.ts";

const { projects: _projects, ...test } = baseConfig.test ?? {};

export default defineConfig({
  test: { ...test, name: "@mines/control", include: ["src/**/*.test.ts"] },
});

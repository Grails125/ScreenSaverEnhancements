import deckyPlugin from "@decky/rollup";
import typescript from "@rollup/plugin-typescript";

const config = deckyPlugin();

export default {
  ...config,
  input: "./src/v2Probe.tsx",
  plugins: config.plugins
    .filter((plugin) => plugin?.name !== "delete")
    .map((plugin) =>
      plugin?.name === "typescript"
        ? typescript({ tsconfig: "./tsconfig.v2-probe.json" })
        : plugin,
    ),
  output: {
    ...config.output,
    dir: "build/v2-probe",
    entryFileNames: "index.js",
    format: "esm",
  },
};

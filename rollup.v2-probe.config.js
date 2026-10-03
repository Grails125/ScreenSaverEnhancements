import config, {cleanOutput} from "./rollup.config.js";
import typescript from "@rollup/plugin-typescript";

export default {
  ...config,
  input: "./src/v2Probe.tsx",
  plugins: config.plugins
    .filter((plugin) => plugin?.name !== "clean-output")
    .map((plugin) =>
      plugin?.name === "typescript"
        ? typescript({ tsconfig: "./tsconfig.v2-probe.json" })
        : plugin,
    ).concat(cleanOutput('build/v2-probe')),
  output: {
    ...config.output,
    dir: "build/v2-probe",
    entryFileNames: "index.js",
    format: "esm",
  },
};

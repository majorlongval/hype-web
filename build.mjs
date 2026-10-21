import * as esbuild from "esbuild";
import { cpSync, mkdirSync } from "node:fs";

const out = "dist/web";
mkdirSync(out, { recursive: true });
cpSync("web/index.html", `${out}/index.html`);
const common = { bundle: true, format: "iife", target: "es2022", sourcemap: true, logLevel: "warning", minify: process.argv.includes("--minify") };
await Promise.all([
  esbuild.build({ ...common, entryPoints: ["src/host/web-main.ts"], outfile: `${out}/main.js` }),
  esbuild.build({ ...common, entryPoints: ["src/host/web-worker.ts"], outfile: `${out}/worker.js` }),
  esbuild.build({ ...common, entryPoints: ["src/host/audio-worklet.ts"], outfile: `${out}/audio-worklet.js` }),
  esbuild.build({ ...common, format: "esm", platform: "node", entryPoints: ["src/host/node-run.ts"], outfile: "dist/node-run.mjs" }),
]);
console.log("built dist/web and dist/node-run.mjs");

#!/usr/bin/env node
// Build the shippable entry: bundle `index.ts` + `src/**` into a single
// `dist/index.js` (all npm packages stay external), and drop a
// `dist/package.json` that types the file as CommonJS.
//
// Why this shape:
//
// pi loads extensions through jiti, which resolves every module of a
// TypeScript import graph file-by-file at startup — hundreds of stat probes
// plus a transform/eval per module (seconds on Windows; the measured root
// cause of slow pi startup — see docs/pi-startup-slow-hashline-readmap.md).
// Bundling collapses the graph to one file: one resolve, one transform.
//
// jiti skips its transform and native-imports `.js` files in `type: "module"`
// packages — but native ESM bypasses jiti's resolver *alias* map, which is how
// pi routes `@earendil-works/*` and `typebox` imports to the host's own
// already-loaded copies. Those packages are deliberately absent from the
// installed extension tree (peer dependencies), so a native import would fail
// with ERR_MODULE_NOT_FOUND — or load a skewed second copy if present.
//
// Marking `dist/` as CommonJS keeps the bundle (which emits ESM syntax) on
// jiti's transform path: its transformed `require` calls go through the alias
// map, exactly like the TypeScript entry does. The transform of the single
// bundle is cached in jiti's fs cache after the first load.
//
// Consequence: `dist/index.js` is for pi's jiti loader only — Node itself
// cannot import it natively. That is intentional.
//
// Runtime assets (prompts/, scripts/) stay at the package root and are
// resolved via src/package-root.ts, which is valid from both the `src/` and
// `dist/` layouts.
import { readFileSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));

// esbuild's JS API resolves the platform binary from its optional dependency,
// so no global install is needed.
const { build } = await import("esbuild");

await rm(join(root, "dist"), { recursive: true, force: true });
await mkdir(join(root, "dist"), { recursive: true });

await build({
  entryPoints: [join(root, "index.ts")],
  outfile: join(root, "dist", "index.js"),
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node22",
  // Keep every npm package external: dependencies resolve from node_modules at
  // runtime (some, like xxhash-wasm and web-tree-sitter, load files from their
  // own package directories), and `@earendil-works/*` + `typebox` must stay
  // bare specifiers so pi's jiti alias map can route them to the host copies.
  packages: "external",
  sourcemap: true,
  logLevel: "warning",
});

await writeFile(
  join(root, "dist", "package.json"),
  '{ "type": "commonjs" }\n',
  "utf8",
);

// Fail fast if the bundle ever loses its ESM syntax or starts inlining
// pi/typebox: both would silently drop the extension back onto native loading
// or break peer resolution in installed trees. tests/dist-build.test.ts pins
// the same contracts.
const bundle = readFileSync(join(root, "dist", "index.js"), "utf8");
const checks = [
  [/^import .* from /m, "bundle must keep ESM import syntax (jiti transform contract)"],
  [/from "@earendil-works\/pi-coding-agent"/, "pi-coding-agent must stay external (host alias contract)"],
  [/from "typebox"/, "typebox must stay external (host alias contract)"],
];
for (const [pattern, message] of checks) {
  if (!pattern.test(bundle)) {
    console.error(`scripts/build.mjs: ${message}`);
    process.exit(1);
  }
}

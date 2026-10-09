import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { PACKAGE_ROOT, PACKAGE_ROOT_URL } from "../src/package-root.js";

// The shippable entry is the bundled `dist/index.js` (see scripts/build.mjs).
// pi's jiti loader must take its transform path for it, and pi's own packages
// must stay external so jiti's alias map routes them to the host's copies.
// These contracts keep the extension loadable (and fast) in installed trees,
// where `@earendil-works/*` and `typebox` are not present at all.

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const distEntry = join(root, "dist", "index.js");

function loadBundle(): string {
  if (!existsSync(distEntry)) {
    throw new Error("dist/index.js is missing — run `npm run build` (or `npm test`, which builds first)");
  }
  return readFileSync(distEntry, "utf8");
}

describe("shippable dist entry", () => {
  it("ships a single bundled entry with a source map", () => {
    expect(existsSync(distEntry)).toBe(true);
    expect(existsSync(distEntry + ".map")).toBe(true);
  });

  it("types dist/ as CommonJS so jiti transforms the bundle (alias-map contract)", () => {
    // Without this file the bundle would be native-imported, bypassing the
    // jiti resolver alias map that routes peer packages to the host copies —
    // installed trees cannot resolve those packages at all.
    const distPackageJson = JSON.parse(readFileSync(join(root, "dist", "package.json"), "utf8"));
    expect(distPackageJson).toEqual({ type: "commonjs" });
  });

  it("keeps ESM syntax so jiti's transform path applies", () => {
    const bundle = loadBundle();
    expect(bundle).toMatch(/^import .* from /m);
    expect(bundle).toMatch(/^export /m);
  });

  it("bundles the internal module graph without relative imports", () => {
    const bundle = loadBundle();
    expect(bundle).not.toMatch(/from "\.\.?\/[^"]*"/);
    expect(bundle).not.toMatch(/import\("\.\.?\/[^"]*"\)/);
  });

  it("keeps pi packages and typebox as external bare specifiers", () => {
    const bundle = loadBundle();
    for (const specifier of [
      "@earendil-works/pi-coding-agent",
      "@earendil-works/pi-tui",
      "@earendil-works/pi-ai",
      "typebox",
    ]) {
      expect(bundle).toContain(`from "${specifier}"`);
    }
  });

  it("declares the bundled entry for pi discovery and package exports", () => {
    const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
    expect(manifest.pi.extensions).toEqual(["./dist/index.js"]);
    expect(manifest.exports["."]).toBe("./dist/index.js");
    expect(manifest.files).toContain("dist/");
    expect(manifest.scripts.prepare).toBeDefined();
  });
});

describe("package-root asset resolution", () => {
  it("resolves the package root from the source layout", () => {
    expect(PACKAGE_ROOT.replace(/[/\\]+$/, "")).toBe(root);
  });

  it("finds prompts and mapper scripts at the package root", () => {
    for (const asset of [
      "prompts/read.md",
      "prompts/edit.md",
      "prompts/bash.md",
      "scripts/python_outline.py",
      "scripts/gdscript_outline.py",
      "scripts/go_outline.go",
    ]) {
      expect(existsSync(fileURLToPath(new URL(asset, PACKAGE_ROOT_URL)))).toBe(true);
    }
  });
});

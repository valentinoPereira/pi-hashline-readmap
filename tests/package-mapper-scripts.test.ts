import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";

const execFileAsync = promisify(execFile);

// Spawn npm through its JS CLI entry: on Windows, spawning the npm.cmd shim
// without a shell is blocked (ENOENT). Under `npm test` / `npx vitest` the
// npm_execpath env var points at npm-cli.js.
const npmExecPath = process.env.npm_execpath;
const npmCommand = npmExecPath?.endsWith(".js")
  ? { command: process.execPath, prefixArgs: [npmExecPath] }
  : { command: "npm", prefixArgs: [] as string[] };

interface PackFile {
  path: string;
}

interface PackResult {
  filename: string;
  files: PackFile[];
}

async function goAvailable(): Promise<boolean> {
  try {
    await execFileAsync("go", ["version"], { timeout: 5_000 });
    return true;
  } catch {
    return false;
  }
}

describe("published mapper scripts", () => {
  afterEach(() => {
    vi.doUnmock("node:url");
    vi.resetModules();
  });

  it("packages runnable Python and Go mapper helpers without the generated Go binary", async () => {
    const root = await mkdtemp(join(tmpdir(), "packed-mapper-scripts-"));
    try {
      const { stdout } = await execFileAsync(
        npmCommand.command,
        // --ignore-scripts: `prepare` would rebuild dist/ mid-suite and race
        // with test files that read it (npm test builds dist via pretest).
        [...npmCommand.prefixArgs, "pack", "--json", "--ignore-scripts", "--pack-destination", root],
        { cwd: process.cwd(), maxBuffer: 10 * 1024 * 1024 },
      );
      const packOutput = JSON.parse(stdout) as PackResult[] | Record<string, PackResult>;
      const packed = Array.isArray(packOutput) ? packOutput[0] : packOutput["pi-hashline-readmap"];
      const paths = packed.files.map((file) => file.path);

      expect(paths).toEqual(expect.arrayContaining([
        "scripts/gdscript_outline.py",
        "scripts/python_outline.py",
        "scripts/go_outline.go",
        "dist/index.js",
        "dist/index.js.map",
        "dist/package.json",
      ]));
      expect(paths).not.toContain("scripts/go_outline");

      if (process.platform === "win32") return;
      await execFileAsync("tar", ["-xzf", join(root, packed.filename), "-C", root]);
      const packageRoot = join(root, "package");
      const pythonFixture = join(root, "sample.py");
      const goFixture = join(root, "sample.go");
      await writeFile(pythonFixture, "def hello():\n    return 1\n", "utf8");
      await writeFile(goFixture, "package main\n\nfunc Hello() int { return 1 }\n", "utf8");

      const actualNodeUrl = await vi.importActual<typeof import("node:url")>("node:url");
      vi.resetModules();
      vi.doMock("node:url", () => ({
        ...actualNodeUrl,
        fileURLToPath(url: string | URL): string {
          const actualPath = actualNodeUrl.fileURLToPath(url);
          // Mapper helper scripts resolve via src/package-root.ts. Redirect the
          // package root to the extracted tarball so the packed scripts — not
          // the dev checkout's — are the ones exercised.
          if (actualPath.replace(/[/\\]+$/, "") === process.cwd()) return packageRoot;
          return actualPath;
        },
      }));

      const { generateMapWithIdentity } = await import("../src/readmap/mapper.js");

      const pythonResult = await generateMapWithIdentity(pythonFixture);
      expect(pythonResult.mapperName).toBe("python");
      expect(pythonResult.map?.language).toBe("Python");
      expect(pythonResult.map?.symbols.map((symbol) => symbol.name)).toContain("hello");

      if (await goAvailable()) {
        const goResult = await generateMapWithIdentity(goFixture);
        expect(goResult.mapperName).toBe("go");
        expect(goResult.map?.language).toBe("Go");
        expect(goResult.map?.symbols.map((symbol) => symbol.name)).toContain("Hello");
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

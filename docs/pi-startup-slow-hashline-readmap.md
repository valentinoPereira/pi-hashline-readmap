# pi startup is slow (>5s) — root cause: `pi-hashline-readmap`

Investigation report. Read-only debugging + profiling; nothing was changed.

## Symptom

pi takes >5 seconds to start. Reproduced ~**6.5s** to start (`pi --help` even reaches 7.1s).

## Root cause

`pi-hashline-readmap`'s **module graph** accounts for ~**4.4s** of the ~6.5s startup. pi loads TypeScript
extensions through **jiti**, and this extension ships a very large TS graph (**106 `.ts` files / ~24,400 lines**)
that jiti must resolve file-by-file at import time. The cost is filesystem-resolution churn (`stat`-heavy),
which scales with module-graph size — **not** with any single slow operation.

## Evidence

### 1. pi's built-in startup instrumentation (`PI_TIMING=1`)

```
--- Startup Timings: main ---
  createAgentSessionRuntime: 6455ms        <-- nearly all of startup
  TOTAL: 6479ms

--- Startup Timings: extensions ---
  herdr-agent-state.ts          module import:   58ms   factory: 1ms
  pi-exa/src/index.ts           module import:  246ms   factory: 8ms
  @aliou/pi-neuralwatt/...      module import:  156ms   factory: 6ms
  pi-herdsman/dist/index.js     module import:   31ms   factory: 2ms
  @juicesharp/rpiv-ask-...      module import:  381ms   factory: 1ms
  pi-hashline-readmap/index.ts  module import: 4413ms   factory: 88ms   <-- HERE
  TOTAL: 5394ms
```

- The slow phase is **`module import`** (transpile + resolve + evaluate the module graph), not `factory`.
- Floor check: `pi --no-extensions` starts in **190ms**. Extensions account for essentially the whole cost,
  and hashline alone is 4.4s of it.

### 2. Not the usual suspects

| Hypothesis | Measured | Verdict |
|---|---|---|
| Sync `ast-grep --version` probe | runs in `factory` = **88ms** | not it |
| Heavy deps (`web-tree-sitter`, `xxhash-wasm`, `diff`, `ignore`, `picomatch`) | native `require` = **55ms total** | not it |
| TypeScript transpile | all 217 transpiles = **78ms total** (cached in `%TEMP%/jiti`, ~1ms each) | not it |

### 3. Where the 4.4s actually goes (CPU profile)

Profiled the **real agent process** directly (`dist/bundle/cli.js`) with `node --cpu-prof`. Note: `pi` is a
launcher (`pi-launcher.js`) that `spawnSync`s the real CLI — profiling `pi` itself only shows the wrapper
waiting on its child, so profile `cli.js` instead.

Self-time is dominated by module-resolution filesystem churn:

| component | self time | what it is |
|---|---|---|
| `node:fs` `stat` / `statSync` | ~1.6s (hundreds of calls) | jiti probing candidate paths to resolve each import |
| `dist/jiti.cjs` (anon frames) | ~2.2s | jiti's transform / eval / resolver JS |
| native / internal (fs syscalls, `url` path↔fileURL) | remainder | module-load churn |

So: jiti resolves hashline's 106-module import graph file-by-file at startup, and the cost is filesystem `stat`
churn (very slow on Windows), not transpilation.

### 4. No warm-up escape

The import stays **4.4–5.4s** across consecutive runs. The transpile cache warms (it lives in `%TEMP%/jiti`),
but the resolution / `stat` churn does not go away.

## Shape of the problem

It is structural to the extension: **many small TS modules → many jiti resolution probes at import time.**

## Options (not yet chosen)

- Report upstream / contribute a fix to reduce or bundle the module graph (fewer entry modules, or ship a
  pre-bundled `dist`).
- Keep the extension but accept ~4.4s, or disable it when fast startup matters.
- A transpile cache would not help much (transpile is already only 78ms).

## How to reproduce these measurements

```sh
# Per-extension startup timings (the key evidence)
PI_TIMING=1 pi --no-session -p "hi" 2>&1 >/dev/null | grep -A200 "Startup Timings"

# Baseline floor without extensions
PI_TIMING=1 pi --no-session --no-extensions -p "hi" 2>&1 >/dev/null | grep -E "TOTAL|createAgentSessionRuntime"

# jiti transpile/cache trace (shows transpile is fast/cached)
JITI_DEBUG=1 pi --no-session -p "hi" 2>&1 | head -40

# CPU profile of the real agent process (resolve cli.js path first)
node --cpu-prof --cpu-prof-dir="$TEMP/cpuprof" "<...>/pi-coding-agent/dist/bundle/cli.js" --no-session -p "hi"
```

Related pi knobs discovered: `PI_TIMING=1` (startup timings), `PI_STARTUP_BENCHMARK=1` (interactive-only
startup benchmark), `--no-extensions`, `JITI_DEBUG=1` / `JITI_FS_CACHE` (jiti transpile cache in `%TEMP%/jiti`).

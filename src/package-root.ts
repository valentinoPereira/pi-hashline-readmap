import { fileURLToPath } from "node:url";

// Package root, valid from both supported layouts: the TypeScript sources
// (`src/**`) and the bundled shippable entry (`dist/index.js`), which sits one
// directory below the package root. Runtime assets (prompts/, scripts/) are
// resolved from the package root, never relative to the emitting module — the
// bundle flattens every module into one file, so per-module relative paths
// would not survive bundling. See scripts/build.mjs.
export const PACKAGE_ROOT_URL = new URL("..", import.meta.url);
export const PACKAGE_ROOT = fileURLToPath(PACKAGE_ROOT_URL);

"use strict";

// Lightweight require.cache injector so the bug-condition exploration test can
// drive the real production modules (toolExecutor, evidenceCollector, the live
// conversationContextService) without touching MongoDB, ChromaDB, Groq, or any
// network. We pre-populate `require.cache` for a list of (relativePath, exports)
// entries BEFORE the consuming modules are required.

const path = require("path");
const Module = require("module");

const REPO_ROOT = path.resolve(__dirname, "..", "..");

const stubModule = (relPath, exportsValue) => {
  const resolved = require.resolve(path.join(REPO_ROOT, relPath));
  require.cache[resolved] = {
    id: resolved,
    filename: resolved,
    loaded: true,
    exports: exportsValue,
    children: [],
    paths: Module._nodeModulePaths(path.dirname(resolved)),
  };
  return resolved;
};

const stubManyModules = (entries) => {
  const stubbed = {};
  for (const [relPath, exportsValue] of entries) {
    stubbed[relPath] = stubModule(relPath, exportsValue);
  }
  return stubbed;
};

module.exports = {
  REPO_ROOT,
  stubModule,
  stubManyModules,
};

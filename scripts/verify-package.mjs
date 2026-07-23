import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const temporaryRoot = mkdtempSync(join(tmpdir(), "tree-patch-package-"));
const packageDirectory = join(temporaryRoot, "package");
const consumerDirectory = join(temporaryRoot, "consumer");

try {
  mkdirSync(packageDirectory);
  mkdirSync(consumerDirectory);

  const packOutput = execFileSync(
    "npm",
    ["pack", "--json", "--pack-destination", packageDirectory],
    {
      cwd: new URL("..", import.meta.url),
      encoding: "utf8",
      stdio: ["ignore", "pipe", "inherit"],
    },
  );
  const packed = JSON.parse(packOutput);
  const archiveName = packed[0]?.filename;
  if (typeof archiveName !== "string") {
    throw new Error("npm pack did not report an archive filename.");
  }

  const packedPaths = new Set(
    (packed[0]?.files ?? []).map((file) => file.path),
  );
  for (const requiredPath of [
    "dist/index.js",
    "dist/index.d.ts",
    "package.json",
  ]) {
    if (!packedPaths.has(requiredPath)) {
      throw new Error(`Packed package is missing ${requiredPath}.`);
    }
  }

  writeFileSync(
    join(consumerDirectory, "package.json"),
    JSON.stringify({ private: true, type: "module" }),
  );
  execFileSync(
    "npm",
    [
      "install",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      join(packageDirectory, archiveName),
    ],
    {
      cwd: consumerDirectory,
      stdio: "inherit",
    },
  );

  const installedManifest = JSON.parse(
    readFileSync(
      join(
        consumerDirectory,
        "node_modules",
        "@hexie",
        "tree-patch",
        "package.json",
      ),
      "utf8",
    ),
  );
  if (installedManifest.name !== "@hexie/tree-patch") {
    throw new Error("Installed package manifest could not be verified.");
  }
  if (
    installedManifest.sideEffects !== false ||
    installedManifest.engines?.node !== ">=18"
  ) {
    throw new Error("Installed package manifest is missing runtime metadata.");
  }

  const installedDist = join(
    consumerDirectory,
    "node_modules",
    "@hexie",
    "tree-patch",
    "dist",
  );
  const pendingDirectories = [installedDist];
  const sourceMapPaths = [];
  while (pendingDirectories.length > 0) {
    const directory = pendingDirectories.pop();
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        pendingDirectories.push(path);
      } else if (entry.name.endsWith(".map")) {
        sourceMapPaths.push(path);
      }
    }
  }
  if (sourceMapPaths.length === 0) {
    throw new Error("Installed package does not contain source maps.");
  }
  for (const sourceMapPath of sourceMapPaths) {
    const sourceMap = JSON.parse(readFileSync(sourceMapPath, "utf8"));
    if (
      !Array.isArray(sourceMap.sources) ||
      !Array.isArray(sourceMap.sourcesContent) ||
      sourceMap.sourcesContent.length !== sourceMap.sources.length ||
      sourceMap.sourcesContent.some(
        (source) => typeof source !== "string",
      )
    ) {
      throw new Error(
        `Installed source map ${sourceMapPath} does not embed its sources.`,
      );
    }
  }

  const entrypoint = pathToFileURL(
    join(
      consumerDirectory,
      "node_modules",
      "@hexie",
      "tree-patch",
      "dist",
      "index.js",
    ),
  );
  const library = await import(entrypoint.href);
  if (typeof library.createDocument !== "function") {
    throw new Error("Packed package entrypoint does not export createDocument().");
  }
} finally {
  rmSync(temporaryRoot, { recursive: true, force: true });
}

import type { PackageJson } from "pkg-types";

import { join, normalize, resolve } from "@reliverse/pathkit";
import { relinka } from "@reliverse/relinka";
import { existsSync } from "node:fs";

import type { BuildEntry, BuildPreset, MkdistBuildEntry } from "~/libs/sdk/sdk-impl/sdk-types";

import { extractExportFilenames, listRecursively, warn } from "./utils";

interface InferEntriesResult {
  cjs?: boolean;
  dts?: boolean;
  entries: BuildEntry[];
  warnings: string[];
}

export function definePreset(preset: BuildPreset): BuildPreset {
  return preset;
}

export const autoPreset: BuildPreset = definePreset(() => {
  return {
    hooks: {
      "build:prepare"(ctx): void {
        // Disable auto if entries already provided or pkg not available
        if (!ctx.pkg || ctx.options.entries.length > 0) {
          return;
        }
        const sourceFiles = listRecursively(join(ctx.options.rootDir, "src"));
        const res = inferEntries(ctx.pkg, sourceFiles, ctx.options.isLib, ctx.options.rootDir);
        for (const message of res.warnings) {
          warn(ctx, message);
        }
        ctx.options.entries.push(...res.entries);
        if (res.cjs) {
          ctx.options.rollup.emitCJS = true;
        }
        if (ctx.options.declaration === undefined) {
          // Enable auto detect based on "package.json"
          // If "package.json" has "types" field, it will be "compatible", otherwise false.
          ctx.options.declaration = res.dts ? "compatible" : false;
        }
        relinka(
          "log",
          "Automatically detected entries:",
          ctx.options.entries
            .map((e) => e.input.replace(`${ctx.options.rootDir}/`, "").replace(/\/$/, "/*"))
            .join(", "),
          ["esm", res.cjs && "cjs", res.dts && "dts"]
            .filter(Boolean)
            .map((tag) => `[${tag}]`)
            .join(" "),
        );
      },
    },
  };
});

const getEntrypointPaths = (path: string): string[] => {
  const segments = normalize(path).split("/");
  return segments.map((_, index) => segments.slice(index).join("/")).filter(Boolean);
};

/**
 * @param {PackageJson} pkg The contents of a package.json file to serve as the source for inferred entries.
 * @param {string[]} sourceFiles A list of source files to use for inferring entries.
 * @param {string | undefined} rootDir The root directory of the project.
 */
function inferEntries(
  pkg: PackageJson,
  sourceFiles: string[],
  isLib: boolean,
  rootDir?: string,
): InferEntriesResult {
  const warnings = [];

  // Sort files so least-nested files are first
  sourceFiles.sort((a, b) => a.split("/").length - b.split("/").length);

  // Come up with a list of all output files & their transpileFormats
  const outputs = extractExportFilenames(pkg.exports);

  if (pkg.bin) {
    const binaries = typeof pkg.bin === "string" ? [pkg.bin] : Object.values(pkg.bin);
    for (const file of binaries) {
      outputs.push({ file });
    }
  }
  if (pkg.main) {
    outputs.push({ file: pkg.main });
  }
  if (pkg.module) {
    outputs.push({ file: pkg.module, type: "esm" });
  }
  if (pkg.types || pkg.typings) {
    outputs.push({ file: (pkg.types || pkg.typings) as string });
  }

  // Try to detect output types
  const isESMPkg = pkg.type === "module";
  for (const output of outputs.filter((o) => !o.type)) {
    const isJS = output.file.endsWith(".js");
    if ((isESMPkg && isJS) || output.file.endsWith(".mjs")) {
      output.type = "esm";
    } else if ((!isESMPkg && isJS) || output.file.endsWith(".cjs")) {
      output.type = "cjs";
    }
  }

  let cjs = false;
  let dts = false;

  // Infer entries from package files
  const entries: BuildEntry[] = [];
  for (const output of outputs) {
    // Supported output file extensions are `.d.ts`, `.cjs` and `.mjs`
    // But we support any file extension here in case user has extended rollup options
    const outputSlug = output.file.replace(/(\*[^/\\]*|\.d\.(m|c)?ts|\.\w+)$/, "");
    const isDir = outputSlug.endsWith("/");

    // Skip top level directory
    if (isDir && ["./", "/"].includes(outputSlug)) {
      continue;
    }

    const possiblePaths = getEntrypointPaths(outputSlug);
    const input = possiblePaths.reduce<string | undefined>((source, d) => {
      if (source) {
        return source;
      }
      const SOURCE_RE = new RegExp(`(?<=/|$)${d}${isDir ? "" : String.raw`\.\w+`}$`);
      return sourceFiles.find((i) => SOURCE_RE.test(i))?.replace(/(\.d\.(m|c)?ts|\.\w+)$/, "");
    }, undefined);

    if (!input) {
      if (!existsSync(resolve(rootDir || ".", output.file))) {
        warnings.push(`Could not find entrypoint for \`${output.file}\``);
      }
      continue;
    }

    if (output.type === "cjs") {
      cjs = true;
    }

    const entry =
      entries.find((i) => i.input === input) || entries[entries.push({ input, isLib }) - 1];

    if (/\.d\.(m|c)?ts$/.test(output.file)) {
      dts = true;
    }

    if (isDir && entry) {
      entry.outDir = outputSlug;
      (entry as MkdistBuildEntry).format = output.type;
    }
  }

  return { cjs, dts, entries, warnings };
}

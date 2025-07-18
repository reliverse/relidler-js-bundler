import path from "@reliverse/pathkit";
import { relinka } from "@reliverse/relinka";
import { defineCommand, defineArgs } from "@reliverse/rempts";
import { createJiti } from "jiti";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import stripJsonComments from "strip-json-comments";

import { isBinaryExt } from "~/libs/sdk/sdk-impl/utils/binary";

/* -------------------------------------------------------------------------- */
/*                                   Types                                    */
/* -------------------------------------------------------------------------- */

interface FileMetadata {
  updatedAt?: string;
  updatedHash?: string;
}

interface TemplatesFileContent {
  content: FileContent;
  type: "text" | "json" | "binary";
  hasError?: boolean;
  error?: string;
  jsonComments?: Record<number, string>;
  binaryHash?: string;
  metadata?: FileMetadata;
}

type FileContent = string | Record<string, unknown>;

interface Template {
  name: string;
  description: string;
  config: { files: Record<string, TemplatesFileContent> };
  updatedAt?: string;
}

type ExistingTemplates = Record<string, Template>;

/* -------------------------------------------------------------------------- */
/*                                  Constants                                 */
/* -------------------------------------------------------------------------- */

const WHITELABEL_DEFAULT = "DLER";
const TEMPLATE_VAR = (name: string, whitelabel: string) =>
  `${whitelabel}_TPL_${name.toUpperCase()}`;
const TPLS_DIR = "packed";
const BINARIES_DIR = "binaries";

/* -------------------------------------------------------------------------- */
/*                               Helper functions                             */
/* -------------------------------------------------------------------------- */

/** Escape back-`s, ${ and newlines for safe template literal embedding */
export const escapeTemplateString = (str: string): string =>
  str
    .replace(/`/g, "\\`")
    // Preserve sequences that have already been escaped (\${}) using a unicode escape for '$'
    .replace(/\\\${/g, "\\u0024{")
    // Escape any remaining ${ so they are not interpreted in the generated file
    .replace(/\$\{/g, "\\${")
    // Remove superfluous escapes before Handlebars/JSX braces that were written as \{{ or \}}
    .replace(/\\\{\{/g, "{{")
    .replace(/\\\}\}/g, "}}")
    .replace(/\r?\n/g, "\\n");

export const unescapeTemplateString = (str: string): string =>
  str
    .replace(/\\n/g, "\n")
    .replace(/\\u0024\{/g, "\\${")
    .replace(/\\\\`/g, "`")
    .replace(/\\\\/g, "\\");

export const hashFile = async (file: string): Promise<string> => {
  const buf = await fs.readFile(file);
  return createHash("sha1").update(buf).digest("hex").slice(0, 10);
};

export const getFileMetadata = async (file: string): Promise<FileMetadata> => {
  try {
    const [stats, hash] = await Promise.all([fs.stat(file), hashFile(file)]);
    return {
      updatedAt: stats.mtime.toISOString(),
      updatedHash: hash,
    };
  } catch (err) {
    relinka("warn", `Failed to get metadata for ${file}: ${(err as Error).message}`);
    return {
      updatedAt: new Date().toISOString(),
      updatedHash: "",
    };
  }
};

/** Recursively walk a directory */
export const walkDir = async (dir: string): Promise<string[]> => {
  let res: string[] = [];
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      res = res.concat(await walkDir(full));
    } else {
      res.push(full);
    }
  }
  return res;
};

/** Process a file and return the TemplatesFileContent structure */
export const readFileForTemplate = async (
  absPath: string,
  relPath: string,
  binariesOutDir: string,
): Promise<TemplatesFileContent> => {
  const metadata = await getFileMetadata(absPath);

  try {
    // Try binary first
    if (await isBinaryExt(absPath)) {
      const hash = metadata.updatedHash;
      const ext = path.extname(absPath);
      const target = path.join(binariesOutDir, `${hash}${ext}`);

      try {
        await fs.mkdir(binariesOutDir, { recursive: true });
        // Copy only if not exists
        await fs.copyFile(absPath, target).catch(async (err) => {
          if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
        });
      } catch (err) {
        relinka("error", `Failed copying binary ${relPath}: ${(err as Error).message}`);
        return {
          content: "",
          type: "binary",
          hasError: true,
          error: (err as Error).message,
          binaryHash: hash,
          metadata,
        };
      }

      return {
        content: "",
        type: "binary",
        binaryHash: hash,
        metadata,
      };
    }

    // Non-binary files are read as text
    const raw = await fs.readFile(absPath, "utf8");
    const ext = path.extname(absPath).toLowerCase();
    if (ext === ".json") {
      const comments: Record<number, string> = {};
      const lines = raw.split(/\r?\n/);

      lines.forEach((line, idx) => {
        const trimmed = line.trim();
        if (trimmed.startsWith("//") || trimmed.startsWith("/*")) comments[idx + 1] = line;
      });

      try {
        const parsed = JSON.parse(stripJsonComments(raw)) as Record<string, unknown>;
        return {
          content: parsed,
          type: "json",
          jsonComments: Object.keys(comments).length ? comments : undefined,
          metadata,
        };
      } catch (err) {
        relinka("warn", `Failed to parse JSON file ${relPath}: ${(err as Error).message}`);
        return {
          content: {} as Record<string, unknown>,
          type: "json",
          hasError: true,
          error: (err as Error).message,
          jsonComments: Object.keys(comments).length ? comments : undefined,
          metadata,
        };
      }
    }

    return {
      content: raw,
      type: "text",
      metadata,
    };
  } catch (err) {
    relinka("warn", `Failed to read file ${relPath}: ${(err as Error).message}`);
    return {
      content: "",
      type: "text",
      hasError: true,
      error: (err as Error).message,
      metadata,
    };
  }
};

/* -------------------------------------------------------------------------- */
/*                             Template UNPACKING                             */
/* -------------------------------------------------------------------------- */

/** Locate the object holding templates in a dynamically-imported module */
const findTemplatesObject = (mod: Record<string, unknown>): ExistingTemplates => {
  if (mod.DLER_TEMPLATES && typeof mod.DLER_TEMPLATES === "object") {
    return mod.DLER_TEMPLATES as ExistingTemplates;
  }
  if (mod.default && typeof mod.default === "object") {
    return mod.default as ExistingTemplates;
  }
  for (const v of Object.values(mod)) {
    if (
      v &&
      typeof v === "object" &&
      Object.values(v).every((t) => t && typeof t === "object" && "config" in t)
    ) {
      return v as ExistingTemplates;
    }
  }
  return {};
};

/** Restore one file (text|json|binary) to the filesystem */
const restoreFile = async (
  outRoot: string,
  relPath: string,
  meta: TemplatesFileContent,
  binsDir: string,
  force = false,
) => {
  const dest = path.join(outRoot, relPath);
  await fs.mkdir(path.dirname(dest), { recursive: true });

  try {
    if (!force) {
      await fs.access(dest);
      relinka("log", `Skipping existing file (use --force to overwrite): ${relPath}`);
      return;
    }
  } catch {
    /* file doesn't exist → proceed */
  }

  if (meta.type === "binary") {
    const ext = path.extname(relPath);
    const src = path.join(binsDir, `${meta.binaryHash}${ext}`);
    try {
      await fs.copyFile(src, dest);
    } catch (err) {
      relinka("error", `Missing binary ${src} for ${relPath}: ${(err as Error).message}`);
    }
  } else if (meta.type === "json") {
    const jsonStr = JSON.stringify(meta.content, null, 2);
    await fs.writeFile(dest, jsonStr, "utf8");
  } else {
    await fs.writeFile(dest, meta.content as string, "utf8");
  }

  /* preserve mtime if available */
  if (meta.metadata?.updatedAt) {
    const ts = new Date(meta.metadata.updatedAt);
    await fs.utimes(dest, ts, ts);
  }
};

/** Unpack logic */
const unpackTemplates = async (
  aggregatorPath: string,
  outDir: string,
  force = false,
): Promise<void> => {
  const jiti = createJiti(process.cwd());
  let mod: Record<string, unknown>;
  try {
    mod = await jiti.import(aggregatorPath);
  } catch (err) {
    throw new Error(`Failed to import aggregator file: ${(err as Error).message}`);
  }

  const templatesObj = findTemplatesObject(mod);
  if (!Object.keys(templatesObj).length) {
    throw new Error("No templates found in aggregator file.");
  }

  const binsDir = path.join(path.dirname(aggregatorPath), TPLS_DIR, BINARIES_DIR);
  let unpackedFiles = 0;

  for (const [tplName, tpl] of Object.entries(templatesObj)) {
    relinka("info", `Unpacking template: ${tplName}`);
    for (const [relPath, meta] of Object.entries(tpl.config.files)) {
      try {
        await restoreFile(outDir, relPath, meta, binsDir, force);
        unpackedFiles++;
      } catch (err) {
        relinka("error", `Failed restoring ${relPath}: ${(err as Error).message}`);
      }
    }
  }

  relinka("success", `Unpacked ${unpackedFiles} files into ${outDir}`);
};

/* -------------------------------------------------------------------------- */
/*                             Template generation                            */
/* -------------------------------------------------------------------------- */

const writeTypesFile = async (outRoot: string, outputName: string) => {
  const typesFile = path.join(outRoot, `${outputName}-types.ts`);
  const code = `// Auto-generated type declarations for templates.

export interface FileMetadata { updatedAt?: string; updatedHash?: string; }
export interface TemplatesFileContent { content: string | Record<string, unknown>; type: 'text' | 'json' | 'binary'; hasError?: boolean; error?: string; jsonComments?: Record<number, string>; binaryHash?: string; metadata?: FileMetadata; }
export interface Template { name: string; description: string; config: { files: Record<string, TemplatesFileContent> }; updatedAt?: string; }
`;
  await fs.writeFile(typesFile, code, "utf8");
};

/* -------------------------------------------------------------------------- */
/*                                   CLI                                      */
/* -------------------------------------------------------------------------- */

export default defineCommand({
  meta: {
    name: "pack",
    version: "1.2.0",
    description: "Pack templates into TS modules or --unpack them back to files",
  },
  args: defineArgs({
    input: {
      type: "positional",
      required: true,
      description: "Input directory (pack) or aggregator file (unpack)",
    },
    output: {
      type: "string",
      default: "my-templates",
      description: "Output dir",
    },
    whitelabel: {
      type: "string",
      default: WHITELABEL_DEFAULT,
      description: "Rename DLER",
    },
    cdn: {
      type: "string",
      description: "Remote CDN for binary assets upload (not yet implemented)",
    },
    force: {
      type: "boolean",
      default: false,
      description: "Force overwrite existing files",
    },
    update: {
      type: "boolean",
      default: true,
      description: "Update existing templates and add new ones (pack mode only)",
    },
    files: {
      type: "string",
      description: "Comma-separated list of specific files to update",
    },
    lastUpdate: {
      type: "string",
      description: "Override lastUpdate timestamp (pack mode only)",
    },
    unpack: {
      type: "boolean",
      default: false,
      description: "Unpack templates from an aggregator file",
    },
  }),
  async run({ args }) {
    if (args.cdn) throw new Error("Remote CDN support is not implemented yet.");

    /* ----------------------------- UNPACK MODE ---------------------------- */
    if (args.unpack) {
      const aggrPath = path.resolve(args.input);
      const outDir = path.resolve(args.output);

      // basic validation
      try {
        const stat = await fs.stat(aggrPath);
        if (!stat.isFile() || !aggrPath.endsWith(".ts")) {
          throw new Error("Input for --unpack must be a TypeScript aggregator file (*.ts)");
        }
      } catch (err) {
        relinka("error", (err as Error).message);
        process.exit(1);
      }

      relinka("info", `Unpacking templates from ${aggrPath} to ${outDir}`);
      try {
        await unpackTemplates(aggrPath, outDir, args.force);
      } catch (err) {
        relinka("error", (err as Error).message);
        process.exit(1);
      }
      return;
    }

    /* ----------------------------- PACK MODE ------------------------------ */
    const dirToProcess = path.resolve(args.input);
    const outDir = path.resolve(args.output);
    const outDirName = path.basename(outDir);
    const typesFile = `${outDirName}-types.ts`;
    const modFile = `${outDirName}-mod.ts`;

    relinka("info", `Packing templates from ${dirToProcess} to ${outDir}`);

    // Parse files to update if specified
    const filesToUpdate = args.files ? new Set(args.files.split(",").map((f) => f.trim())) : null;

    // Check if output directory exists and handle accordingly
    let existingTemplates: ExistingTemplates = {};
    try {
      const files = await fs.readdir(outDir);
      if (files.length > 0) {
        if (!args.force && !args.update) {
          relinka("error", `Error: Output directory '${outDir}' already exists and is not empty.`);
          relinka(
            "error",
            "Use --force to overwrite all files or --update to update existing templates.",
          );
          process.exit(1);
        }

        if (args.update) {
          // Load existing templates for update mode
          try {
            const modPath = path.join(outDir, modFile);
            const jiti = createJiti(process.cwd());
            const mod = await jiti.import<{
              DLER_TEMPLATES?: ExistingTemplates;
              default?: ExistingTemplates;
            }>(modPath);
            existingTemplates = mod?.DLER_TEMPLATES || mod?.default || {};
          } catch (loadError) {
            relinka(
              "warn",
              `Warning: Could not load existing templates from ${modFile}. Will create new ones.`,
            );
            relinka("log", `Error details: ${(loadError as Error).message}`);
          }
        }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
      // Directory doesn't exist, which is fine
    }

    await fs.mkdir(path.join(outDir, TPLS_DIR), { recursive: true });

    const templateDirs = (await fs.readdir(dirToProcess, { withFileTypes: true }))
      .filter((d) => d.isDirectory())
      .map((d) => d.name);

    // Create types.ts file if it doesn't exist
    try {
      await fs.access(path.join(outDir, typesFile));
    } catch {
      await writeTypesFile(outDir, outDirName);
    }

    const aggregatedImports: string[] = [];
    const aggregatedEntries: string[] = [];
    const mapEntries: string[] = [];

    for (const tplName of templateDirs) {
      relinka("info", `Processing template: ${tplName}`);
      const absTplDir = path.join(dirToProcess, tplName);
      const allFiles = await walkDir(absTplDir);
      const filesRecord: Record<string, TemplatesFileContent> = {};

      // Get existing template if in update mode
      const existingTemplate = args.update ? existingTemplates[tplName] : null;
      const existingFiles = existingTemplate?.config?.files || {};

      for (const absFile of allFiles) {
        const rel = path.relative(dirToProcess, absFile).replace(/\\/g, "/");

        // Skip if we're only updating specific files and this isn't one of them
        if (filesToUpdate && !filesToUpdate.has(rel)) {
          if (existingFiles[rel]) {
            filesRecord[rel] = existingFiles[rel];
          }
          continue;
        }

        const fileMetadata = await getFileMetadata(absFile);
        const existingFile = existingFiles[rel];
        const existingMetadata = existingFile?.metadata;

        // Skip if file hasn't changed (same hash) or if source file is older
        if (
          existingMetadata?.updatedHash &&
          fileMetadata.updatedHash &&
          (existingMetadata.updatedHash === fileMetadata.updatedHash ||
            (fileMetadata.updatedAt &&
              existingMetadata.updatedAt &&
              fileMetadata.updatedAt <= existingMetadata.updatedAt))
        ) {
          filesRecord[rel] = existingFile as TemplatesFileContent;
          continue;
        }

        const meta = await readFileForTemplate(
          absFile,
          rel,
          path.join(outDir, TPLS_DIR, BINARIES_DIR),
        );

        if (meta.type === "binary") {
          const hash = await hashFile(absFile);
          const ext = path.extname(absFile);
          const binariesDir = path.join(outDir, TPLS_DIR, BINARIES_DIR);
          const target = path.join(binariesDir, `${hash}${ext}`);

          await fs.mkdir(binariesDir, { recursive: true });

          try {
            await fs.access(target);
          } catch {
            await fs.copyFile(absFile, target);
          }

          filesRecord[rel] = {
            type: "binary",
            content: "",
            binaryHash: hash,
            metadata: fileMetadata,
          };
          continue;
        }

        // json post-processing
        if (meta.type === "json") {
          // no side-effect additions here
        }

        filesRecord[rel] = {
          ...meta,
          metadata: fileMetadata,
        };
      }

      /** ---------- emit template module ---------- */
      const varName = TEMPLATE_VAR(tplName, args.whitelabel);
      const code: string[] = [];

      // Determine if we need to import types from `pkg-types`.
      // 1) Detect by file ‑ path (more reliable for minimal files).
      // 2) Fallback to structure detection to stay compatible with the previous logic.
      const hasPackageJson =
        Object.keys(filesRecord).some((rel) => rel.endsWith("package.json")) ||
        Object.values(filesRecord).some(
          (f) =>
            f.type === "json" && f.content && typeof f.content === "object" && "name" in f.content,
        );

      const tsconfigPathRe = /(?:^|\/)tsconfig(?:\.[^/]+)?\.json$/;
      const hasTSConfig =
        Object.keys(filesRecord).some((rel) => tsconfigPathRe.test(rel)) ||
        Object.values(filesRecord).some(
          (f) =>
            f.type === "json" &&
            f.content &&
            typeof f.content === "object" &&
            "compilerOptions" in f.content,
        );

      if (hasPackageJson || hasTSConfig) {
        const t: string[] = [];
        if (hasPackageJson) t.push("PackageJson");
        if (hasTSConfig) t.push("TSConfig");
        code.push(`import type { ${t.join(", ")} } from "pkg-types";`);
        code.push("", `import type { Template } from "../${typesFile}";`);
      } else {
        code.push(`import type { Template } from "../${typesFile}";`);
      }
      code.push(""); // blank line after imports
      code.push(`export const ${varName}: Template = {`);
      code.push(`  name: "${tplName}",`);
      code.push(`  description: "Template generated from ${allFiles.length} files",`);
      code.push(`  updatedAt: "${new Date().toISOString()}",`);
      code.push("  config: {");
      code.push("    files: {");

      const fileEntries = Object.entries(filesRecord);
      fileEntries.forEach(([rel, meta], index) => {
        const isLast = index === fileEntries.length - 1;
        code.push(`      "${rel}": {`);
        if (meta.jsonComments)
          code.push(`        jsonComments: ${JSON.stringify(meta.jsonComments, null, 2)},`);
        if (meta.metadata) {
          const metadataStr = JSON.stringify(meta.metadata, null, 2)
            .replace(/^/gm, "        ")
            .replace(/^ {7} {/m, " {")
            .replace(/^ {8}}/m, "        }")
            .replace(/"([a-zA-Z0-9_]+)":/g, "$1:")
            .replace(/\n(\s*)}/, ",\n$1}")
            .replace(/}$/m, "},");
          code.push(`        metadata:${metadataStr}`);
        }
        if (meta.type === "binary") {
          code.push(`        content: "",`);
          code.push(`        type: "binary",`);
          code.push(`        binaryHash: "${meta.binaryHash}",`);
        } else if (meta.type === "text") {
          code.push(`        content: \`${escapeTemplateString(meta.content as string)}\`,`);
          code.push('        type: "text",');
        } else {
          let clone: Record<string, unknown>;
          let sat = "";

          try {
            // Create a deep clone to avoid readonly property issues
            clone = JSON.parse(JSON.stringify(meta.content)) as Record<string, unknown>;

            // Add type satisfaction annotations if the
            // file is a package.json or tsconfig.json
            if (rel.endsWith("package.json")) {
              sat = " satisfies PackageJson";
            } else if (tsconfigPathRe.test(rel)) {
              sat = " satisfies TSConfig";
            }
          } catch (error) {
            clone = {};
            relinka("error", `Failed to process JSON content for ${rel}: ${error}`);
          }

          const jsonStr = JSON.stringify(clone, null, 2)
            .split("\n")
            .map((line, i) => {
              if (i === 0) return line;
              // Remove quotes from single-word property names and reduce indentation by 2 spaces
              return `        ${line.replace(/"([a-zA-Z0-9_]+)":/g, "$1:")}`;
            })
            .join("\n")
            .replace(/\n(\s*)}/, ",\n$1}")
            .replace(/,\s*,/g, ","); // Remove double commas
          code.push(`        content: ${jsonStr}${sat},`);
          code.push('        type: "json",');
        }
        if (meta.hasError) {
          code.push("        hasError: true,");
          if (meta.error) {
            code.push(`        error: "${escapeTemplateString(meta.error)}",`);
          }
        }
        code.push(`      }${isLast ? "" : ","}`); // TODO: [consider] code.push(`      }${isLast ? "," : ","}`);
      });

      code.push("    },");
      code.push("  },");
      code.push("};");
      code.push(""); // Add blank line at the end

      const templatePath = path.join(outDir, TPLS_DIR, `${tplName}.ts`);

      // In update mode, check if template exists and has conflicts
      if (args.update && existingTemplates[tplName]) {
        try {
          const existingContent = await fs.readFile(templatePath, "utf8");
          const newContent = code.join("\n");

          if (existingContent !== newContent) {
            if (filesToUpdate) {
              relinka("log", `Updating specific files in template: ${tplName}`);
            } else {
              relinka("log", `Updating template: ${tplName}`);
            }
          }
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
            throw error;
          }
          relinka("log", `Creating new template: ${tplName}`);
        }
      } else if (!args.update) {
        relinka("log", `Creating template: ${tplName}`);
      }

      // Log files with errors
      const filesWithErrors = Object.entries(filesRecord).filter(([_, meta]) => meta.hasError);
      if (filesWithErrors.length > 0) {
        relinka("warn", `Template ${tplName} has files with errors:`);
        for (const [file, meta] of filesWithErrors) {
          relinka("warn", `  - ${file}: ${meta.error || "Unknown error"}`);
        }
      }

      await fs.writeFile(templatePath, code.join("\n"));

      /** aggregate */
      aggregatedImports.push(`import { ${varName} } from "./${TPLS_DIR}/${tplName}";`);
      aggregatedEntries.push(`  ${tplName}: ${varName},`);
      mapEntries.push(`  ${varName}: "${tplName}",`);
    }

    /** ---------- aggregator ---------- */
    const WL = args.whitelabel.toUpperCase();
    const mod = [
      ...aggregatedImports,
      "",
      `const ${WL}_TEMPLATES_OBJ = {`,
      ...aggregatedEntries,
      "};",
      "",
      `export const ${WL}_TEMPLATES = ${WL}_TEMPLATES_OBJ;`,
      "",
      `export type ${WL}_TEMPLATE_NAMES = keyof typeof ${WL}_TEMPLATES;`,
      "",
      `export const ${WL.toLowerCase()}TemplatesMap: Record<string, ${WL}_TEMPLATE_NAMES> = {`,
      ...mapEntries,
      "};",
    ];
    await fs.writeFile(path.join(outDir, modFile), mod.join("\n") + "\n");

    const templatePaths = templateDirs.map((tpl) =>
      path.relative(process.cwd(), path.join(outDir, TPLS_DIR, `${tpl}.ts`)),
    );
    relinka("success", `Packed ${templateDirs.length} templates into ${modFile}:`);
    for (const p of templatePaths) {
      relinka("log", `- ${p}`);
    }

    // Log binary files count
    const binaryCount = Object.values(existingTemplates).reduce((count, template) => {
      return (
        count + Object.values(template.config.files).filter((file) => file.type === "binary").length
      );
    }, 0);

    if (binaryCount > 0) {
      relinka("info", `  - ${TPLS_DIR}/${BINARIES_DIR}/* (${binaryCount} binary files)`);
    }
  },
});

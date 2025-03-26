import type { BuildPublishConfig } from "./cfg-types.js";

/**
 * Default configuration for the build and publish logic.
 */
export const DEFAULT_CONFIG: BuildPublishConfig = {
  bumpDisable: false,
  bumpFilter: ["package.json", "reliverse.ts"],
  bumpMode: "autoPatch",
  commonPubPause: true,
  commonPubRegistry: "npm",
  commonVerbose: false,
  coreDeclarations: true,
  coreEntryFile: "main.ts",
  coreEntrySrcDir: "src",
  coreIsCLI: false,
  distJsrAllowDirty: true,
  distJsrBuilder: "jsr",
  distJsrCopyRootFiles: ["README.md", "LICENSE"],
  distJsrDirName: "dist-jsr",
  distJsrDryRun: false,
  distJsrGenTsconfig: false,
  distJsrOutFilesExt: "ts",
  distJsrSlowTypes: true,
  distNpmBuilder: "mkdist",
  distNpmCopyRootFiles: ["README.md", "LICENSE"],
  distNpmDirName: "dist-npm",
  distNpmOutFilesExt: "js",
  libsActMode: "main-project-only",
  libsDirDist: "dist-libs",
  libsDirSrc: "src/libs",
  libsList: {},
  logsFileName: "relinka.log",
  logsFreshFile: true,
  rmDepsMode: "patterns-and-devdeps",
  rmDepsPatterns: [
    "@types",
    "biome",
    "eslint",
    "knip",
    "prettier",
    "typescript",
    "@reliverse/config",
  ],
  transpileEsbuild: "es2023",
  transpileFormat: "esm",
  transpileMinify: true,
  transpilePublicPath: "/",
  transpileSourcemap: "none",
  transpileSplitting: false,
  transpileStub: false,
  transpileTarget: "node",
  transpileWatch: false,
};

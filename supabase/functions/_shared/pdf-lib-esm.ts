// pdf-lib's single-file ES module build, with the package's own types. Its CommonJS entry (the package "main") loads several
// hundred small modules through Node compatibility and costs about 0.4 s of CPU to import on a cold worker (about 0.07 s for
// this file): document-signing maps "pdf-lib" here so a cold request stays under the 2 s CPU limit (546, 2026-11-20).
// @ts-types="npm:pdf-lib@1.17.1"
export * from "npm:pdf-lib@1.17.1/dist/pdf-lib.esm.js";

/* eslint-disable no-console */
/**
 * Quick benchmark for the conflict resolver's two hottest paths:
 *
 *   1. parseConflictMarkers throughput on synthetic files.
 *   2. ConflictStore.buildSnapshot latency on a mocked document loader.
 *
 * Usage:
 *   npx tsx scripts/benchmark.ts             # default sizes
 *   npx tsx scripts/benchmark.ts --large     # 2000 files
 *
 * Output is a small table; no dependencies beyond what's already in
 * devDependencies. tsx is recommended but tsc + node also work.
 */

import { performance } from "node:perf_hooks";

import { parseConflictMarkers } from "../src/conflictParser";
import { ConflictStore } from "../src/conflictStore";
import type {
  ConflictStoreDocument,
  ConflictStoreDocumentLoader,
  ConflictStoreGitService,
} from "../src/conflictStore";
import type { GitUnmergedFile } from "../src/types";

type Row = {
  label: string;
  files: number;
  conflictsPerFile: number;
  totalMs: number;
  perFileMs: number;
};

const args = new Set(process.argv.slice(2));
const large = args.has("--large");

type FileSize = "small" | "medium" | "large";
const fileLines: Record<FileSize, number> = {
  small: 200,
  medium: 800,
  large: 2000,
};

const conflictsPerFile = 10;

function buildSyntheticFile(lines: number, conflictCount: number): string {
  const out: string[] = [];
  for (let i = 0; i < lines; i += 1) {
    out.push(`// line ${i}`);
  }
  for (let c = 0; c < conflictCount; c += 1) {
    const startLine = Math.floor((c * lines) / (conflictCount + 1));
    out[startLine] = `<<<<<<< HEAD`;
    out[startLine + 1] = `ours ${c}`;
    out[startLine + 2] = `=======`;
    out[startLine + 3] = `theirs ${c}`;
    out[startLine + 4] = `>>>>>>> branch`;
  }
  return out.join("\n");
}

function benchParse(fileCount: number, size: FileSize, lines: number): Row {
  const fileText = buildSyntheticFile(lines, conflictsPerFile);
  const start = performance.now();
  let totalConflicts = 0;
  for (let i = 0; i < fileCount; i += 1) {
    const parsed = parseConflictMarkers(fileText);
    totalConflicts += parsed.blocks.length;
  }
  const totalMs = performance.now() - start;
  return {
    label: `parseConflictMarkers × ${fileCount} (${size})`,
    files: fileCount,
    conflictsPerFile,
    totalMs,
    perFileMs: totalMs / fileCount,
  };
}

function buildMockLoader(fileCount: number, lines: number): ConflictStoreDocumentLoader {
  const fileText = buildSyntheticFile(lines, conflictsPerFile);
  const documents: ConflictStoreDocument[] = [];
  const files: GitUnmergedFile[] = [];
  for (let i = 0; i < fileCount; i += 1) {
    const uri = `file:///repo/bench/file-${i}.ts`;
    documents.push({ uri, getText: () => fileText });
    files.push({
      uri,
      repositoryRoot: "/repo/bench",
      relativePath: `file-${i}.ts`,
    });
  }
  return {
    getOpenDocuments: async () => documents,
    loadDocument: async (uri) => documents.find((doc) => doc.uri === uri),
    getRepositoryRoots: async () => ["/repo/bench"],
    readDiskText: async (uri) => {
      const doc = documents.find((candidate) => candidate.uri === uri);
      return doc?.getText();
    },
  };
}

function buildMockGitService(fileCount: number): ConflictStoreGitService {
  return {
    async findRepositoryRoot(uri) {
      return uri.startsWith("file:///repo/bench/") ? "/repo/bench" : undefined;
    },
    async listUnmergedFiles(repositoryRoot) {
      if (repositoryRoot !== "/repo/bench") {
        return [];
      }
      const files: GitUnmergedFile[] = [];
      for (let i = 0; i < fileCount; i += 1) {
        files.push({
          uri: `file:///repo/bench/file-${i}.ts`,
          repositoryRoot: "/repo/bench",
          relativePath: `file-${i}.ts`,
        });
      }
      return files;
    },
  };
}

async function benchStore(fileCount: number, size: FileSize, lines: number): Promise<Row> {
  const documents = buildMockLoader(fileCount, lines);
  const git = buildMockGitService(fileCount);
  const store = new ConflictStore({
    documents,
    git,
    includeLockFiles: false,
  });
  const start = performance.now();
  const snapshot = await store.refresh();
  const totalMs = performance.now() - start;
  if (snapshot.locatedCount !== fileCount * conflictsPerFile) {
    console.warn(
      `  ⚠️  expected ${fileCount * conflictsPerFile} conflicts, got ${snapshot.locatedCount}`,
    );
  }
  return {
    label: `ConflictStore.refresh × ${fileCount} (${size})`,
    files: fileCount,
    conflictsPerFile,
    totalMs,
    perFileMs: totalMs / fileCount,
  };
}

function formatRow(row: Row): string {
  return [
    row.label.padEnd(46),
    `${row.totalMs.toFixed(1).padStart(7)} ms`,
    `(${(row.perFileMs * 1000).toFixed(1).padStart(7)} µs/file)`,
  ].join("  ");
}

async function main(): Promise<void> {
  const sizes: Array<{ name: FileSize; lines: number; count: number }> = large
    ? [
        { name: "small", lines: fileLines.small, count: 2000 },
        { name: "large", lines: fileLines.large, count: 2000 },
      ]
    : [
        { name: "small", lines: fileLines.small, count: 200 },
        { name: "medium", lines: fileLines.medium, count: 500 },
      ];

  console.log("Conflict Resolver benchmark");
  console.log("============================");
  console.log(
    `Node ${process.version} · ${new Date().toISOString()} · ${large ? "large" : "default"} run`,
  );
  console.log("");

  for (const size of sizes) {
    const parseRow = benchParse(size.count, size.name, size.lines);
    console.log(formatRow(parseRow));
  }

  console.log("");

  for (const size of sizes) {
    const storeRow = await benchStore(size.count, size.name, size.lines);
    console.log(formatRow(storeRow));
  }

  console.log("");
  console.log("Run with --large for 2000-file scenarios.");
}

main().catch((error) => {
  console.error("Benchmark failed:", error);
  process.exitCode = 1;
});

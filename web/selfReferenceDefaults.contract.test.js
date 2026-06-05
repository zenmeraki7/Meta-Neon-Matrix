import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve("web");
const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", "coverage"]);
const JS_FILE = /\.(mjs|cjs|js)$/;

function listJsFiles(dir, files = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) {
        listJsFiles(path.join(dir, entry.name), files);
      }
      continue;
    }
    if (JS_FILE.test(entry.name)) {
      files.push(path.join(dir, entry.name));
    }
  }
  return files;
}

function stripComments(source) {
  return source
    .replace(/\/\/.*$/gm, (match) => " ".repeat(match.length))
    .replace(/\/\*[\s\S]*?\*\//g, (match) => " ".repeat(match.length));
}

function lineNumber(source, index) {
  return source.slice(0, index).split(/\r?\n/).length;
}

function findSelfReferenceLandmines(file) {
  const source = fs.readFileSync(file, "utf8");
  const searchable = stripComments(source);
  const findings = [];
  const selfDefaultPattern =
    /(?<![.$\w])(db|prisma|tx|client)\s*=\s*\1(?![\w$])/g;
  const shadowFallbackPattern =
    /(?<![.$\w])(?:const|let|var)\s+(db|prisma|tx|client)\s*=\s*[^;\n]*\|\|\s*\1(?![\w$])/g;

  for (const match of searchable.matchAll(selfDefaultPattern)) {
    findings.push(`${file}:${lineNumber(source, match.index)}:${match[0].trim()}`);
  }
  for (const match of searchable.matchAll(shadowFallbackPattern)) {
    findings.push(`${file}:${lineNumber(source, match.index)}:${match[0].trim()}`);
  }
  return findings;
}

test("service/repository code has no DB-like self-referential defaults", () => {
  const findings = listJsFiles(ROOT)
    .flatMap(findSelfReferenceLandmines)
    .filter((line) => !line.includes("selfReferenceDefaults.contract.test.js"));

  assert.deepEqual(findings, []);
});

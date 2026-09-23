#!/usr/bin/env node
// @ts-check
/**
 * Codemod quality linter — enforces rules that prevent silent patch failures
 * and version-sensitive hardcoding. Run via `mise run lint:codemods` or directly.
 *
 * Rules:
 *   R1  No hardcoded minified-name defaults (2-4 char string literals used as fallbacks)
 *   R2  No `totalChanged > 0` marker gates — must use `>= REQUIRED_CHANGES`
 *   R3  Multi-sub-patch codemods must define REQUIRED_CHANGES constant
 *   R4  No hardcoded BUILD_TOOL_DEFAULT or similar minified-name default constants
 *   R5  Discovery failures must return {changed: 0}, not fall through with a default
 */

"use strict";

const fs = require("fs");
const path = require("path");

const CODEMODS_DIR = path.join(__dirname, "..", "codemods");


// Rule definitions — each rule receives (src, lines, file) to avoid
// redundant string splitting across rules.


/** @type {{ id: string; desc: string; check: (src: string, lines: string[], file: string) => string[] }[]} */
const rules = [
  {
    id: "R1",
    desc: "No hardcoded minified-name defaults (2-4 char identifiers as string fallbacks)",
    check(src, lines, file) {
      const findings = [];
      for (let i = 0; i < lines.length; i++) {
        const match = lines[i].match(/\b(?:DEFAULT|FALLBACK)\b\s*=\s*["']([a-zA-Z_]\w{0,3})["']/i);
        if (match && !["true", "false", "null", "undefined"].includes(match[1])) {
          findings.push(`  ${file}:${i + 1}: hardcoded minified default "${match[1]}"`);
        }
      }
      return findings;
    },
  },
  {
    id: "R2",
    desc: "No `totalChanged > 0` marker gates — use `>= REQUIRED_CHANGES` instead",
    check(src, lines, file) {
      const findings = [];
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (/totalChanged\s*>\s*0/.test(line)) {
          const ctx = lines.slice(Math.max(0, i - 3), i + 4).join("\n");
          if (/patched__|marker/i.test(ctx)) {
            findings.push(`  ${file}:${i + 1}: use "totalChanged >= REQUIRED_CHANGES" not "totalChanged > 0" for marker gate`);
          }
        }
      }
      return findings;
    },
  },
  {
    id: "R3",
    desc: "Multi-sub-patch codemods must define REQUIRED_CHANGES",
    check(src, lines, file) {
      const hasMarker = /var\s+__\w+_patched__\s*=\s*true/.test(src);
      const hasRequired = /REQUIRED_CHANGES/.test(src);
      if (hasMarker && !hasRequired) {
        return [`  ${file}: has marker injection but no REQUIRED_CHANGES constant`];
      }
      return [];
    },
  },
  {
    id: "R4",
    desc: "No BUILD_TOOL_DEFAULT or similar minified-name constants",
    check(src, lines, file) {
      const findings = [];
      const matches = src.matchAll(/(?:const|let|var)\s+(?:\w*(?:BUILD_TOOL|DEFAULT|FALLBACK)\w*)\s*=/g);
      for (const m of matches) {
        const line = src.slice(m.index, m.index + 200).split("\n")[0];
        if (/=\s*["'][a-zA-Z_]\w{0,4}["']/.test(line)) {
          const lineNum = src.slice(0, m.index).split("\n").length;
          findings.push(`  ${file}:${lineNum}: minified-name default constant: ${line.trim()}`);
        }
      }
      return findings;
    },
  },
  {
    id: "R5",
    desc: "Discovery failures must return early, not fall through with defaults",
    check(src, lines, file) {
      const findings = [];
      for (let i = 0; i < lines.length; i++) {
        if (/console\.(error|warn)\([^)]*discovery failed/i.test(lines[i])) {
          const nextLines = lines.slice(i, i + 4).join("\n");
          if (!/return\s*\{[^}]*changed\s*:\s*0/.test(nextLines)) {
            findings.push(`  ${file}:${i + 1}: discovery failure warning without early return {changed: 0}`);
          }
        }
      }
      return findings;
    },
  },
];


// Main


function main() {
  const files = fs.readdirSync(CODEMODS_DIR).filter((f) => f.startsWith("codemod-") && f.endsWith(".cjs"));
  let totalFindings = 0;
  let filesWithFindings = 0;

  console.log(`Linting ${files.length} codemods against ${rules.length} rules...\n`);

  for (const file of files) {
    const filePath = path.join(CODEMODS_DIR, file);
    const src = fs.readFileSync(filePath, "utf8");
    const lines = src.split("\n");
    const findings = [];

    for (const rule of rules) {
      findings.push(...rule.check(src, lines, file));
    }

    if (findings.length > 0) {
      filesWithFindings++;
      totalFindings += findings.length;
      for (const f of findings) {
        console.error(f);
      }
    }
  }

  console.error(`\n${files.length} codemods checked, ${totalFindings} findings in ${filesWithFindings} files.`);

  if (totalFindings > 0) {
    process.exit(1);
  }
  process.exit(0);
}

main();

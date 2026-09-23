#!/usr/bin/env node
/**
 * Check line lengths and artifact markers for common bundle leaks.
 * Passing this check does not establish fixture provenance.
 * Usage: node bin/fixture-audit.cjs [--max-line N] [--scope dir ...]
 */

const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const DEFAULT_SCOPES = ["test", "codemods", "docs"];
const DEFAULT_EXTS = new Set([".js", ".cjs", ".md"]);
const DEFAULT_MAX_LINE = 1000;
const DENY = [
  "__BUN", // Bun binary section marker: bundle bytes, never source
  "@bun-cjs", // bundle header: bundle bytes, never source
  "FULL_PROMPT", // extracted system-prompt dump (docs/FULL_PROMPT_*.md)
];
// Short marker strings also occur in synthetic fixtures and parser code.
// Check longer lines for these markers; provenance still needs review.
const DENY_MIN_LINE = 120;

function parseArgs() {
  const out = { maxLine: DEFAULT_MAX_LINE, scopes: [...DEFAULT_SCOPES] };
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--max-line") out.maxLine = parseInt(argv[++i], 10);
    else if (argv[i] === "--scope") { out.scopes = []; while (argv[i + 1] && !argv[i + 1].startsWith("--")) out.scopes.push(argv[++i]); }
    else { console.error(`Unknown arg: ${argv[i]}`); process.exit(2); }
  }
  return out;
}

function* walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === "node_modules") continue;
      yield* walk(p);
    } else if (DEFAULT_EXTS.has(path.extname(e.name))) {
      yield p;
    }
  }
}

function main() {
  const { maxLine, scopes } = parseArgs();
  const offenses = [];
  for (const scope of scopes) {
    const dir = path.join(ROOT, scope);
    if (!fs.existsSync(dir)) continue;
    for (const file of walk(dir)) {
      const rel = path.relative(ROOT, file);
      const lines = fs.readFileSync(file, "utf8").split("\n");
      lines.forEach((ln, idx) => {
        if (ln.length > maxLine) {
          offenses.push(`${rel}:${idx + 1}: line too long (${ln.length} > ${maxLine}) — bundle excerpts are single huge lines; split or shrink the fixture`);
        }
        for (const pat of DENY) {
          if (ln.length > DENY_MIN_LINE && ln.includes(pat)) offenses.push(`${rel}:${idx + 1}: denylisted marker '${pat}'`);
        }
      });
    }
  }
  if (offenses.length > 0) {
    console.error(`fixture-audit: ${offenses.length} offense(s):`);
    for (const o of offenses.slice(0, 30)) console.error(`  ${o}`);
    if (offenses.length > 30) console.error(`  ... and ${offenses.length - 30} more`);
    process.exit(1);
  }
  console.log(`fixture-audit: clean (scopes: ${scopes.join(", ")}, max-line ${maxLine})`);
}

if (require.main === module) main();
module.exports = { main };

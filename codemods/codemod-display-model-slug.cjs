#!/usr/bin/env node

const fs = require("fs");
const path = require("path");

const MOD_ID = "display_model_slug";

const MODEL_PREFIXES = {
  sonnet: "Sonnet 4.6 · ",
  sonnet_xB7: "Sonnet 4.6 \xB7 ",
  sonnet_us: "Sonnet 4.6 _ ",
  opus: "Opus 4.6 · ",
  opus_xB7: "Opus 4.6 \xB7 ",
  opus_us: "Opus 4.6 _ ",
  opus47: "Opus 4.7 · ",
  opus48: "Opus 4.8 · ",
  haiku: "Haiku 4.5 · ",
  haiku_xB7: "Haiku 4.5 \xB7 ",
  haiku_us: "Haiku 4.5 _ ",
};

const MODEL_SLUG_ARGS = {
  sonnet: "sonnet",
  sonnet_xB7: "sonnet",
  sonnet_us: "sonnet",
  opus: "opus",
  opus_xB7: "opus",
  opus_us: "opus",
  opus47: "opus",
  opus48: "opus",
  haiku: "haiku",
  haiku_xB7: "haiku",
  haiku_us: "haiku",
};

const REQUIRED_MODEL_KEYS = ["opus", "sonnet", "haiku"];

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Find the slug resolver — tries object literal first, then switch-in-function.
 * Returns { type: "object"|"function", name: "..." } or null.
 */
function findSlugResolver(code) {
  // Strategy 1: Object literal slug map
  // const NAME = { opus: "claude-opus-...", sonnet: "claude-sonnet-...", haiku: "claude-haiku-..." };
  const objLiteralPattern = /(?:const|let|var)\s+([\w$]+)\s*=\s*\{[^}]*opus:\s*"claude-[^"]*"[^}]*sonnet:\s*"claude-[^"]*"[^}]*haiku:\s*"claude-[^"]*"[^}]*\}/g;
  let objCandidates = [];
  let m;
  while ((m = objLiteralPattern.exec(code)) !== null) {
    const name = m[1];
    const declIdx = m.index;
    const before = code.substring(Math.max(0, declIdx - 500), declIdx);
    // Count nested function depth at this position
    let funcDepth = 0;
    let depth = 0;
    for (let i = before.length - 1; i >= 0; i--) {
      if (before[i] === '}') depth++;
      if (before[i] === '{') { if (depth > 0) { depth--; } else { funcDepth++; } }
    }
    // Accept top-level (0) or CJS wrapper (1)
    // Also accept if preceded by (function( — CJS wrapper pattern
    const isCJSWrapper = /\(function\s*\(/.test(before);
    const effectiveDepth = isCJSWrapper ? funcDepth - 1 : funcDepth;
    // Verify the map has all required keys
    const mapBody = m[0];
    if (REQUIRED_MODEL_KEYS.every(k => mapBody.includes(`${k}: "claude-`))) {
      objCandidates.push({ name, depth: effectiveDepth, index: declIdx });
    }
  }
  // Prefer the candidate with the lowest effective depth (top-level or CJS wrapper)
  if (objCandidates.length > 0) {
    objCandidates.sort((a, b) => a.depth - b.depth || a.index - b.index);
    return { type: "object", name: objCandidates[0].name };
  }

  // Strategy 1b: Assignment expression (lazy init)
  // NAME = { opus: "claude-opus-...", sonnet: "claude-sonnet-...", haiku: "claude-haiku-..." };
  const assignPattern = /([\w$]+)\s*=\s*\{[^}]*opus:\s*"claude-[^"]*"[^}]*sonnet:\s*"claude-[^"]*"[^}]*haiku:\s*"claude-[^"]*"[^}]*\}/g;
  while ((m = assignPattern.exec(code)) !== null) {
    const name = m[1];
    // Check there's a var declaration for this name at top level or CJS wrapper
    const varDecl = new RegExp(`(?:const|let|var)\\s+${escapeRegex(name)}\\b`);
    if (varDecl.test(code)) {
      return { type: "object", name };
    }
  }

  // Strategy 2: Switch-in-function slug resolver
  // Monolithic: returns string literals like return "claude-opus-4-6"
  // Code-split: returns variables like return zB (which hold the slug strings)
  const switchPattern = /function\s+([\w$]+)\s*\(([\w$]+)\)\s*\{[^}]*switch\s*\(\s*[\w$]+\s*\)\s*\{[^}]*case\s+"opus"[\s\S]*?return\s+(?:"[^"]*"|[\w$]+)[\s\S]*?case\s+"sonnet"[\s\S]*?return\s+(?:"[^"]*"|[\w$]+)[\s\S]*?case\s+"haiku"[\s\S]*?return\s+(?:"[^"]*"|[\w$]+)/g;
  let switchCandidates = [];
  while ((m = switchPattern.exec(code)) !== null) {
    const name = m[1];
    const funcBody = m[0];
    // Check that return values look like slugs (string literals starting with "claude-"
    // or variable references)
    const caseReturns = [...funcBody.matchAll(/case\s+"(opus|sonnet|haiku)"[\s\S]*?return\s+(["'][^"']*"?|[\w$]+)/g)];
    let allValid = true;
    for (const cr of caseReturns) {
      const val = cr[2];
      // Accept either string literals starting with "claude-" or variable references
      if (val.startsWith('"') && !/^"claude-/.test(val)) { allValid = false; break; }
    }
    if (allValid) {
      const declIdx = m.index;
      const before = code.substring(Math.max(0, declIdx - 500), declIdx);
      let funcDepth = 0;
      let depth = 0;
      for (let i = before.length - 1; i >= 0; i--) {
        if (before[i] === '}') depth++;
        if (before[i] === '{') { if (depth > 0) { depth--; } else { funcDepth++; } }
      }
      const isCJSWrapper = /\(function\s*\(/.test(before);
      const effectiveDepth = isCJSWrapper ? funcDepth - 1 : funcDepth;
      switchCandidates.push({ name, depth: effectiveDepth, index: declIdx });
    }
  }
  if (switchCandidates.length > 0) {
    switchCandidates.sort((a, b) => a.depth - b.depth || a.index - b.index);
    return { type: "function", name: switchCandidates[0].name };
  }

  return null;
}

/**
 * Get model key from a description prefix text.
 */
function getModelKey(text) {
  for (const [key, prefix] of Object.entries(MODEL_PREFIXES)) {
    if (text.startsWith(prefix)) return key;
  }
  return null;
}

/**
 * Transform model description strings:
 * - TemplateLiteral: `Sonnet 4.6 · ${cost}` → `Sonnet (${eO7?.["sonnet"] ?? ""}) · ${cost}`
 * - StringLiteral: "Haiku 4.5 · Fast" → `Haiku (${eO7?.["haiku"] ?? ""}) · Fast`
 *
 * Also handles the `description:` property context.
 */
function transform(code) {
  if (typeof code !== "string") return { code: "", changed: 0 };

  // Idempotency: check if already applied (our output format includes the slug resolver access)
  const alreadyApplied = code.includes(`__isModEnabled__("${MOD_ID}")`) &&
    (code.includes('?.["sonnet"]') || code.includes('?.["opus"]') || code.includes('slugResolver('));
  if (alreadyApplied) {
    return { code, changed: 0 };
  }

  const resolver = findSlugResolver(code);
  if (!resolver) {
    throw new Error(
      "Could not find slug resolver (neither object-literal map nor switch-in-function). " +
      "The target code structure may have changed."
    );
  }

  const modGuard = `typeof __isModEnabled__ === "function" && __isModEnabled__("${MOD_ID}")`;

  // Build the slug lookup expression for a given model key
  function slugExpr(modelKey) {
    const slugArg = MODEL_SLUG_ARGS[modelKey];
    if (resolver.type === "object") {
      return `${resolver.name}?.["${slugArg}"] ?? ""`;
    } else {
      return `${resolver.name}("${slugArg}")`;
    }
  }

  let count = 0;

  // Transform description values only.
  // We look for description: `PREFIX...` or description: "PREFIX..." patterns
  for (const [key, prefix] of Object.entries(MODEL_PREFIXES)) {
    const escapedPrefix = escapeRegex(prefix);

    // Pattern: description: `PREFIX${...}` (template literal)
    // Pattern: description: `PREFIX...` (template literal)
    // Negative lookahead: don't match already-patched descriptions
    const descTemplatePattern = new RegExp(
      "description:\\s*`" + escapedPrefix + "((?:(?!__isModEnabled__).)*?)`",
      "g"
    );
    code = code.replace(descTemplatePattern, (match, rest) => {
      const name = prefix.trimEnd().replace(/ · $/, "");
      const slug = slugExpr(key);
      return `description: \`${name} (\${${modGuard} ? ${slug} : ""}) · ${rest}\``;
    });

    // Pattern: description: "PREFIX..." (string literal)
    // Negative lookahead: don't match already-patched descriptions
    const descStringPattern = new RegExp(
      "description:\\s*\"" + escapedPrefix + "((?:(?!__isModEnabled__).)*?)\"",
      "g"
    );
    code = code.replace(descStringPattern, (match, rest) => {
      const name = prefix.trimEnd().replace(/ · $/, "");
      const slug = slugExpr(key);
      return `description: \`${name} (\${${modGuard} ? ${slug} : ""}) · ${rest}\``;
    });
  }

  // Count how many we transformed
  count = (code.match(new RegExp(`__isModEnabled__\\("${MOD_ID}"\\)`, "g")) || []).length;

  if (count === 0) {
    // Check if already applied
    if (code.includes(`__isModEnabled__("${MOD_ID}")`)) {
      return { code, changed: 0 };
    }
    throw new Error(
      "No matching model descriptions found and patch does not appear already applied. " +
      "The target code structure may have changed."
    );
  }

  return { code, changed: count };
}

function main() {
  const [, , inputFile, outputFile] = process.argv;
  if (!inputFile) {
    console.error("Usage: codemod-display-model-slug.cjs <input.js> [output.js]");
    process.exit(1);
  }

  const inputPath = path.resolve(inputFile);
  if (!fs.existsSync(inputPath)) {
    console.error(`Error: Input file not found: ${inputPath}`);
    process.exit(1);
  }

  const code = fs.readFileSync(inputPath, "utf8");

  let result;
  try {
    result = transform(code);
  } catch (err) {
    console.error(`Error: ${err.message}`);
    process.exit(1);
  }

  if (result.changed === 0) {
    console.error("Patch already applied — no changes needed (idempotent no-op).");
  } else {
    console.error(`Patched ${result.changed} model description(s).`);
  }

  if (outputFile) {
    const outputPath = path.resolve(outputFile);
    const outputDir = path.dirname(outputPath);
    if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });
    fs.writeFileSync(outputPath, result.code, "utf8");
  } else {
    process.stdout.write(result.code);
  }
}

module.exports = { transform };

if (require.main === module) {
  main();
}

#!/usr/bin/env node
/**
 * Shared utility functions for the patch system.
 *
 * Provides reusable YAML parsing and pattern matching helpers used by
 * bin/batch-apply.cjs, the shared patch engine (lib/engine.cjs),
 * bin/patch.cjs, codemods, and tests.
 *
 * Two categories of functions:
 *   - Pure helpers: coerceValue, parseKV, finalizeListObj, parseYAML,
 *     validatePattern, patternExistsIn, countMatchesIn
 *   - File-based helpers: patternExists, countMatches (use fs.readFileSync)
 */

const fs = require("fs");

// Coerce string values from YAML to native JS types
function coerceValue(value) {
  if (value === undefined) return value;
  if (value === "true") return true;
  if (value === "false") return false;
  // Integer: optional minus, digits, no leading zero (unless exactly "0")
  if (/^-?\d+$/.test(value) && (value.length === 1 || value[0] !== "0")) return parseInt(value, 10);
  // Float: optional minus, digits, dot, digits
  if (/^-?\d+\.\d+$/.test(value)) return parseFloat(value);
  return value;
}

// Parse a "key: value" string with quote handling, returns {key, value} or null
function parseKV(text) {
  let colonIndex = -1;
  let inQuote = false;
  let quoteChar = null;

  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    // Count preceding backslashes to detect escaped quotes
    let escapeCount = 0;
    for (let j = i - 1; j >= 0 && text[j] === '\\'; j--) escapeCount++;
    const isEscaped = (escapeCount % 2) === 1;

    if ((c === '"' || c === "'") && !inQuote && !isEscaped) {
      inQuote = true;
      quoteChar = c;
    } else if (c === quoteChar && inQuote && !isEscaped) {
      inQuote = false;
      quoteChar = null;
    } else if (c === ':' && !inQuote) {
      colonIndex = i;
      break;
    }
  }

  if (colonIndex === -1) return null;

  const key = text.substring(0, colonIndex).trim();
  let value = text.substring(colonIndex + 1).trim();

  // Remove matching quotes from value (only if unescaped)
  let wasQuoted = false;
  for (const q of ['"', "'"]) {
    if (value.startsWith(q) && value.endsWith(q) && value.length >= 2) {
      value = value.slice(1, -1);
      wasQuoted = true;
      break;
    }
  }

  return { key, value: coerceValue(value), wasQuoted };
}

// Finalize a list object that was being accumulated
function finalizeListObj(result, currentSection, subSectionKey, currentListObj) {
  if (subSectionKey && currentListObj && currentSection) {
    const section = result[currentSection];
    if (!Array.isArray(section)) {
      if (!section[subSectionKey]) section[subSectionKey] = [];
      section[subSectionKey].push(currentListObj);
    }
  }
}

// Simple YAML parser (no external deps) — supports 3-level nesting for mod.config arrays
function parseYAML(content) {
  const result = {};
  const lines = content.split("\n");
  let currentSection = null;
  let subSectionKey = null;
  let currentListObj = null;

  // 4-level nesting: list items within list items (e.g. mod.config[].options[])
  let listItemIndent = -1;
  let subArrayKey = null;     // key name of the nested sub-array (e.g., "options")
  let subArrayItems = [];     // accumulated items for the nested sub-array
  let subArrayItemIndent = -1; // indent of items within the sub-array

  for (const rawLine of lines) {
    const line = rawLine.replace(/\t/g, "  "); // Normalize tabs to spaces
    if (!line.trim() || line.trim().startsWith("#")) continue;

    // Determine indent level: 0 (top), 2 (section), 4+ (sub-section or list-item props)
    const indent = line.search(/\S/);

    if (indent === 0) {
      // Top-level property
      const colonIndex = line.indexOf(":");
      if (colonIndex === -1) continue;

      // Finalize any pending list object before switching context
      finalizeListObj(result, currentSection, subSectionKey, currentListObj);
      subSectionKey = null;
      currentListObj = null;
      listItemIndent = -1;
      subArrayKey = null;
      subArrayItems = [];
      subArrayItemIndent = -1;

      const key = line.substring(0, colonIndex).trim();
      let value = line.substring(colonIndex + 1).trim();

      // Empty value after colon → section with nested sub-properties.
      // Non-empty value → scalar property.
      if (value === "") {
        currentSection = key;
        result[key] = {};
      } else {
        currentSection = null;
        for (const q of ['"', "'"]) {
          if (value.startsWith(q) && value.endsWith(q) && value.length >= 2) {
            value = value.slice(1, -1);
            break;
          }
        }
        result[key] = coerceValue(value);
      }
    } else if (indent >= 2 && indent < 4) {
      // Section-level (2-space indent)
      if (!currentSection) continue;

      // Finalize any pending list object
      finalizeListObj(result, currentSection, subSectionKey, currentListObj);
      subSectionKey = null;
      currentListObj = null;
      listItemIndent = -1;
      subArrayKey = null;
      subArrayItems = [];
      subArrayItemIndent = -1;

      const trimmed = line.trim();

      // Initialize nested section if needed
      if (!result[currentSection]) {
        result[currentSection] = {};
      }

      // Handle array items (starting with "- ")
      if (trimmed.startsWith("- ")) {
        if (!Array.isArray(result[currentSection])) {
          if (Object.keys(result[currentSection]).length > 0) {
            throw new Error(
              `parseYAML: section "${currentSection}" has key-value pairs but also contains list items — mixed content not supported`
            );
          }
          result[currentSection] = [];
        }
        result[currentSection].push(coerceValue(trimmed.substring(2).trim().replace(/^["']|["']$/g, '')));
        continue;
      }

      const kv = parseKV(trimmed);
      if (!kv) continue;

      // If this is a key with a value, store it. If key-only (sub-section), mark for nesting.
      if (Array.isArray(result[currentSection])) {
        throw new Error(
          `parseYAML: section "${currentSection}" is an array but contains key "${kv.key}" — mixed content not supported`
        );
      }
      result[currentSection][kv.key] = kv.value;
    } else if (indent >= 4) {
      // Sub-section level (4+ space indent) — handles list item properties and sub-keys
      if (!currentSection) continue;

      const section = result[currentSection];
      if (Array.isArray(section)) continue;

      const trimmed = line.trim();

      // Array items at sub-section level (e.g. "    - key: ...")
      if (trimmed.startsWith("- ")) {
        // If we're inside a sub-array (e.g., options: within a config item),
        // and this item is deeper than the parent list item, it belongs to
        // the sub-array — not a new top-level list item.
        if (subArrayKey && indent > listItemIndent) {
          const subItem = {};
          const itemContent = trimmed.substring(2).trim();
          const kv = parseKV(itemContent);
          if (kv) subItem[kv.key] = kv.value;
          // Check if next line is a deeper property of this sub-item —
          // handled by the property path below which checks subArrayKey.
          subArrayItems.push(subItem);
          subArrayItemIndent = indent;
          continue;
        }

        // Close any pending sub-array before finalizing the parent list item
        if (subArrayKey && currentListObj) {
          currentListObj[subArrayKey] = subArrayItems;
          subArrayKey = null;
          subArrayItems = [];
        }

        // Finalize any previous list object
        finalizeListObj(result, currentSection, subSectionKey, currentListObj);
        currentListObj = {};
        listItemIndent = indent;

        const itemContent = trimmed.substring(2).trim();
        const kv = parseKV(itemContent);
        if (kv) {
          currentListObj[kv.key] = kv.value;
          // Convention: mod.config is a list-backed subsection where each item
          // starts with "- key: <name>". We hardcode "config" as the subsection
          // name because that's the only 3-level nesting pattern in use today.
          // To support new patterns, add a mapping here (e.g. from section name
          // or key pattern to subsection key).
          if (!subSectionKey && kv.key === "key") {
            subSectionKey = "config";
          }
        }
        continue;
      }

      // Properties of a list item
      if (currentListObj) {
        const kv = parseKV(trimmed);
        if (kv) {
          // Only an unquoted key with no value starts a nested array.
          // A quoted empty-string default is a value, not a subsection.
          if (kv.value === "" && !kv.wasQuoted && indent > listItemIndent) {
            // Close any previous sub-array first
            if (subArrayKey) {
              currentListObj[subArrayKey] = subArrayItems;
            }
            subArrayKey = kv.key;
            subArrayItems = [];
            continue;
          }
          // Property of a sub-array item (e.g., "label:" within options[])
          if (subArrayKey && subArrayItems.length > 0 && indent > subArrayItemIndent) {
            subArrayItems[subArrayItems.length - 1][kv.key] = kv.value;
            continue;
          }
          currentListObj[kv.key] = kv.value;
        }
        continue;
      }

      // Regular sub-section key-value pair
      const kv = parseKV(trimmed);
      if (kv) {
        section[kv.key] = kv.value;
      }
    }
  }

  // Finalize last pending list object (close sub-array first if active)
  if (subArrayKey && currentListObj) {
    currentListObj[subArrayKey] = subArrayItems;
  }
  finalizeListObj(result, currentSection, subSectionKey, currentListObj);

  return result;
}

// Validate and sanitize regex patterns to prevent ReDoS
function validatePattern(pattern) {
  // Detect nested quantified groups: (...)+ or (...)* or (...){n,}
  // This catches patterns like (a+)+, (.*)+, (\w+)*, (?:a+)+, etc.
  // Matches both capturing (...) and non-capturing (?:...) groups.
  const nestedQuantifiedGroup = /\((?:\?:)?[^)]*[+*{][^)]*\)[+*{]/;
  if (nestedQuantifiedGroup.test(pattern)) {
    throw new Error(`Potentially dangerous pattern detected (nested quantified group): ${pattern}`);
  }

  // Reject unanchored leading lookaheads with unbounded any-character scans: missing
  // matches can rescan the bundle at every position, causing quadratic work.
  // Anchored and trailing lookaheads are outside this check.
  const leadingWildcardLookahead = /^\(\?=[^)]*\[\\s\\S\][+*]/;
  if (leadingWildcardLookahead.test(pattern)) {
    throw new Error(
      `Potentially dangerous pattern detected (leading unbounded-wildcard lookahead, O(n^2) on no-match): ${pattern}`,
    );
  }
}

// Check if a pattern exists in a file
function patternExists(filePath, pattern) {
  validatePattern(pattern);

  let content;
  try {
    content = fs.readFileSync(filePath, "utf8");
  } catch {
    return false;
  }

  // Let RegExp errors propagate — syntax errors indicate a broken pattern
  const regex = new RegExp(pattern);
  return regex.test(content);
}

// Count pattern matches in a file
function countMatches(filePath, pattern) {
  validatePattern(pattern);

  let content;
  try {
    content = fs.readFileSync(filePath, "utf8");
  } catch {
    return 0;
  }

  // Let RegExp errors propagate — syntax errors indicate a broken pattern
  const regex = new RegExp(pattern, "g");
  const matches = content.match(regex);
  return matches ? matches.length : 0;
}

/**
 * Check if a pattern exists in an in-memory string.
 * Used by the shared patch engine to verify patterns without re-reading from disk.
 *
 * @param {string} content - The string to search in
 * @param {string} pattern - Regex pattern string to search for
 * @returns {boolean} True if pattern matches
 */
function patternExistsIn(content, pattern) {
  validatePattern(pattern);
  return new RegExp(pattern).test(content);
}

/**
 * Count pattern matches in an in-memory string.
 * Used by the shared patch engine to count occurrences without re-reading from disk.
 *
 * @param {string} content - The string to search in
 * @param {string} pattern - Regex pattern string to search for
 * @returns {number} Number of matches
 */
function countMatchesIn(content, pattern) {
  validatePattern(pattern);
  const regex = new RegExp(pattern, "g");
  const matches = content.match(regex);
  return matches ? matches.length : 0;
}

/**
 * Find the position of the matching closing bracket/brace, starting from
 * the opening bracket. Skips braces inside string/template literals and
 * handles template literal ${...} expressions.
 *
 * @param {string} code - Source code to scan
 * @param {number} start - Position of the opening bracket ('{' or '[')
 * @param {string} open - Opening character ('{' or '[')
 * @param {string} close - Closing character ('}' or ']')
 * @returns {number} Position of the matching close bracket, or -1 if not found
 */
function findMatchingBrace(code, start, open, close) {
  let depth = 0;
  for (let i = start; i < code.length; i++) {
    const ch = code[i];
    if (ch === '"' || ch === "'" || ch === "`") {
      const quote = ch;
      i++;
      while (i < code.length) {
        if (code[i] === "\\") { i += 2; continue; }
        if (code[i] === quote) break;
        if (quote === "`" && code[i] === "$" && i + 1 < code.length && code[i + 1] === "{") {
          i += 2;
          let td = 1;
          while (i < code.length && td > 0) {
            if (code[i] === "{") td++;
            else if (code[i] === "}") td--;
            if (td > 0) i++;
          }
        }
        i++;
      }
    } else if (ch === open) {
      depth++;
    } else if (ch === close) {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/**
 * Check syntax without changing the input. Older Node parsers need single-line
 * await-using statements blanked in a temporary copy, preserving positions.
 * Those statements are not validated; multiline forms remain unchanged.
 * Return null or syntax stderr; throw on checker failures.
 */
function syntaxCheckModern(filePath) {
  const { execFileSync } = require("child_process");
  const fs = require("fs");
  const os = require("os");
  const path = require("path");
  const src = fs.readFileSync(filePath, "utf8");
  const sanitized = src.replace(/^[ \t]*await[ \t]+using[ \t]+[\w$]+[ \t]*=[^;\n]*;[ \t]*$/gm, (m) => " ".repeat(m.length));
  const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "cm-check-")), "check.js");
  fs.writeFileSync(tmp, sanitized);
  try {
    const env = { ...process.env };
    delete env.NODE_OPTIONS;
    execFileSync(process.execPath, ["--js-explicit-resource-management", "--check", tmp], {
      stdio: ["ignore", "ignore", "pipe"],
      timeout: 120000,
      env,
    });
    return null;
  } catch (e) {
    const stderr = (e.stderr || "").toString();
    // Rewrite the tmp path back to the real path so positions read cleanly.
    const cleaned = stderr.split(tmp).join(filePath);
    if (!/SyntaxError/.test(cleaned)) {
      throw new Error(`syntax check failed without a parse error:\n${cleaned.slice(0, 500)}`);
    }
    return cleaned;
  } finally {
    try { fs.rmSync(path.dirname(tmp), { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

module.exports = {
  coerceValue,
  parseKV,
  parseYAML,
  findMatchingBrace,
  validatePattern,
  patternExists,
  countMatches,
  patternExistsIn,
  countMatchesIn,
  syntaxCheckModern,
};

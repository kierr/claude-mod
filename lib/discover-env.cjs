"use strict";
/**
 * Inventory configuration-namespace environment reads for the CLI and Environment tab.
 * Read counts and line numbers describe this input only, not a stable API.
 */

const CONFIG_NAMESPACES = [
  [/^CLAUDE_CODE_/, "Claude Code"],
  [/^CLAUDE_/, "Claude"],
  [/^ANTHROPIC_/, "Provider & Auth"],
  [/^DISABLE_/, "Toggles"],
  [/^ENABLE_/, "Toggles"],
  [/^BASH_/, "Bash & Tooling"],
  [/^MCP_/, "MCP"],
  [/^API_/, "Limits & Timeouts"],
  [/^MAX_/, "Limits & Timeouts"],
];

function categorize(name) {
  for (const [re, category] of CONFIG_NAMESPACES) {
    if (re.test(name)) return category;
  }
  return null;
}

// Build an array of line-start offsets once, so line numbers are O(log n) per lookup
// instead of O(n) slice+split per match.
function buildLineIndex(code) {
  const lines = [0];
  for (let i = 0; i < code.length; i++) {
    if (code.charCodeAt(i) === 10) lines.push(i + 1);
  }
  return lines;
}

function lineForIndex(lines, idx) {
  let lo = 0;
  let hi = lines.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (lines[mid] <= idx) lo = mid;
    else hi = mid - 1;
  }
  return lo + 1; // 1-based
}

// Both access forms in the bundle: process.env.NAME and process.env["NAME"].
const PATTERNS = [
  /process\.env\.([A-Z][A-Z0-9_]*)/g,
  /process\.env\[\s*["']([A-Z][A-Z0-9_]*)["']\s*\]/g,
];

/**
 * @param {string} code
 * @returns {Array<{name:string,tier:"discovered",category:string,reads:number,first_line:number}>}
 */
function discoverEnvVars(code) {
  const lineIndex = buildLineIndex(code);
  const tally = new Map();

  for (const re of PATTERNS) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(code)) !== null) {
      const name = m[1];
      let e = tally.get(name);
      if (!e) {
        e = { reads: 0, firstIdx: m.index };
        tally.set(name, e);
      }
      e.reads++;
    }
  }

  const entries = [];
  for (const [name, e] of tally) {
    const category = categorize(name);
    if (!category) continue;
    entries.push({
      name,
      tier: "discovered",
      category,
      reads: e.reads,
      first_line: lineForIndex(lineIndex, e.firstIdx),
    });
  }
  entries.sort((a, b) => a.name.localeCompare(b.name));
  return entries;
}

module.exports = { discoverEnvVars, categorize, CONFIG_NAMESPACES };

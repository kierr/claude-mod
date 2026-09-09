#!/usr/bin/env node
// The standalone Bun launcher cannot dispatch native ugrep/bfs subcommands.
// Disable those shell wrappers without removing unrelated shell setup.

"use strict";

const { findMatchingBrace } = require("../lib/utils.cjs");

const MOD_ID = "fix_shell_grep";

// Locate both shell anchors, then use the shared delimiter scanner to find
// function boundaries. A broad regex cannot track nested JavaScript structure.
function findUgrepFunction(code) {
  const anchor = '"unalias grep';
  let searchFrom = 0;
  while (searchFrom < code.length) {
    const anchorIdx = code.indexOf(anchor, searchFrom);
    if (anchorIdx < 0) return null;

    // Require both anchors within the bounded search window.
    const ugrepIdx = code.indexOf('"ugrep"', anchorIdx);
    if (ugrepIdx < 0 || ugrepIdx - anchorIdx > 5000) {
      searchFrom = anchorIdx + anchor.length;
      continue;
    }

    // Walk backwards from the anchor to find the function declaration start
    let funcStart = -1;
    for (let j = anchorIdx - 1; j >= 0; j--) {
      if (code.substring(j, j + 8) === "function") {
        // Verify it's actually a function declaration (not inside a string)
        // by checking that only whitespace precedes it back to a line boundary
        let k = j - 1;
        while (k >= 0 && (code[k] === " " || code[k] === "\t")) k--;
        if (k < 0 || code[k] === "\n" || code[k] === "{" || code[k] === ";" || code[k] === "}") {
          funcStart = j;
          break;
        }
      }
    }
    if (funcStart < 0) {
      searchFrom = anchorIdx + anchor.length;
      continue;
    }

    // Find the opening brace and count to matching close
    const openBrace = code.indexOf("{", funcStart);
    if (openBrace < 0) {
      searchFrom = anchorIdx + anchor.length;
      continue;
    }

    const closeBrace = findMatchingBrace(code, openBrace, "{", "}");
    if (closeBrace === -1) {
      searchFrom = anchorIdx + anchor.length;
      continue;
    }

    const funcEnd = closeBrace + 1;
    const funcText = code.substring(funcStart, funcEnd);


    const nameMatch = /function\s+([\w$]+)\s*\(/.exec(funcText);
    if (!nameMatch) {
      searchFrom = anchorIdx + anchor.length;
      continue;
    }

    return { start: funcStart, end: funcEnd, name: nameMatch[1], text: funcText };
  }
  return null;
}

function transform(code) {
  // Quick check — skip if already patched (idempotency via marker)
  if (code.includes("__DUS__")) {
    return { code, changed: 0 };
  }

  // Quick check — skip if the anchor substrings don't exist
  if (!code.includes('"ugrep"') || !code.includes('"unalias grep')) {
    return { code, changed: 0 };
  }

  const fn = findUgrepFunction(code);
  if (!fn) {
    return { code, changed: 0 };
  }

  // Extract original body (between first { and last })
  const bodyStart = fn.text.indexOf("{") + 1;
  const bodyEnd = fn.text.lastIndexOf("}");
  const originalBody = fn.text.substring(bodyStart, bodyEnd).trim();

  // Indent detection: find leading whitespace of the function declaration
  const lineStart = code.lastIndexOf("\n", fn.start - 1) + 1;
  const indent = code.substring(lineStart, fn.start).match(/^(\s*)/)[1];

  const replacement =
    indent + `function ${fn.name}() {\n` +
    indent + `    if(typeof __isModEnabled__==="function"&&__isModEnabled__("fix_shell_grep"))return null; /* __DUS__ */\n` +
    indent + "    " + originalBody.replace(/\n/g, "\n" + indent + "    ") + "\n" +
    indent + "  }";

  const newCode = code.substring(0, fn.start) + replacement + code.substring(fn.end);
  return { code: newCode, changed: 1 };
}

/** CLI wrapper */
function main() {
  const fs = require("fs");
  const path = require("path");

  const [, , inputFile, outputFile] = process.argv;
  if (!inputFile) {
    console.error("Usage: codemod-fix-shell-grep.cjs <input.js> [output.js]");
    process.exit(1);
  }

  const inputPath = path.resolve(inputFile);
  const code = fs.readFileSync(inputPath, "utf8");

  const { code: output, changed } = transform(code);

  if (changed === 0) {
    console.error("No matching ugrep/bfs shell function found; nothing changed.");
  } else {
    console.error(`Disabled ugrep/bfs shell function (${MOD_ID}).`);
  }

  if (outputFile) {
    fs.writeFileSync(path.resolve(outputFile), output, "utf8");
  } else {
    process.stdout.write(output);
  }
}

module.exports = { transform };

if (require.main === module) {
  main();
}

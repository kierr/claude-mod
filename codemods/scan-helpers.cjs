/**
 * String/comment-aware brace and paren scanning utilities.
 *
 * Minified code may contain braces/parens inside string literals or comments
 * that naive depth-counting would misinterpret as structural delimiters.
 * These helpers skip string literals (single/double-quoted, template),
 * single-line comments, and multi-line comments during scanning.
 *
 * Each codemod is a standalone CJS module loaded by lib/engine.cjs, so
 * shared helpers live here and are required explicitly.
 */

/**
 * Advance past a string literal, template literal, or comment starting at `code[pos]`.
 * Returns `pos` unchanged if `code[pos]` is not the start of one of these constructs.
 * Otherwise returns the position immediately after the construct.
 */
function skipStringOrComment(code, pos) {
  const ch = code[pos];
  if (ch === '"' || ch === "'") {
    const q = ch;
    let p = pos + 1;
    while (p < code.length) {
      if (code[p] === '\\') { p += 2; continue; }
      if (code[p] === q) { return p + 1; }
      p++;
    }
    return p;
  }
  if (ch === '`') {
    let p = pos + 1;
    let tplDepth = 0;
    while (p < code.length) {
      if (code[p] === '\\') { p += 2; continue; }
      if (code[p] === '`' && tplDepth === 0) { return p + 1; }
      if (code.substring(p, p + 2) === '${') { tplDepth++; p += 2; continue; }
      if (code[p] === '}' && tplDepth > 0) { tplDepth--; }
      p++;
    }
    return p;
  }
  if (ch === '/' && code[pos + 1] === '/') {
    const nl = code.indexOf('\n', pos);
    return nl === -1 ? code.length : nl + 1;
  }
  if (ch === '/' && code[pos + 1] === '*') {
    const end = code.indexOf('*/', pos + 2);
    return end === -1 ? code.length : end + 2;
  }
  return pos;
}

/**
 * Find the matching closing brace for an opening brace at `braceStart`.
 * String and comment content is skipped so interior braces don't affect depth.
 * Returns the index of the closing brace, or -1 if not found.
 */
function findMatchingBrace(code, braceStart) {
  let depth = 1;
  let i = braceStart + 1;
  while (i < code.length && depth > 0) {
    const skipped = skipStringOrComment(code, i);
    if (skipped !== i) { i = skipped; continue; }
    if (code[i] === '{') depth++;
    else if (code[i] === '}') depth--;
    i++;
  }
  return depth === 0 ? i - 1 : -1;
}

/**
 * Find the matching closing paren for an opening paren at `parenStart`.
 * String and comment content is skipped so interior parens don't affect depth.
 * Returns the index of the closing paren, or -1 if not found.
 */
function findMatchingParen(code, parenStart) {
  let depth = 1;
  let i = parenStart + 1;
  while (i < code.length && depth > 0) {
    const skipped = skipStringOrComment(code, i);
    if (skipped !== i) { i = skipped; continue; }
    if (code[i] === '(') depth++;
    else if (code[i] === ')') depth--;
    i++;
  }
  return depth === 0 ? i - 1 : -1;
}

module.exports = { skipStringOrComment, findMatchingBrace, findMatchingParen };

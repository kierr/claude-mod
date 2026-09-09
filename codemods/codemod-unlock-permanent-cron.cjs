#!/usr/bin/env node
// Propagate the permanent field through schema validation, tool dispatch, and persistence; the scheduler already checks it.

const fs = require("fs");
const path = require("path");

const MOD_ID = "unlock_permanent_cron";

const PERMANENT_DESC =
  'true = exempt from 7-day auto-expiry. Only meaningful with durable: true. Permanent tasks never age out. Use for long-lived infrastructure tasks that should persist indefinitely.';

/**
 * Injection 1: Add `permanent` field to CronCreate strictObject schema.
 *
 * Anchors: "scheduled_tasks.json" in durable describe, h.strictObject
 */
function injectSchema(code) {
  const MARKER = "persist to .claude/scheduled_tasks.json and survive restarts";
  const idx = code.indexOf(MARKER);
  if (idx === -1) return null;

  // Walk forward from the marker to find the closing of the .describe("...") call
  const fromMarker = code.slice(idx);
  const describeClose = fromMarker.match(/^.*?["']\s*\)/);
  if (!describeClose) return null;

  const durableEnd = idx + describeClose[0].length;

  // Get indent from the line containing the durable property
  const lineStart = code.lastIndexOf("\n", idx) + 1;
  const indent = code.slice(lineStart).match(/^(\s*)/)[1];

  // Extract both zod wrapper and zod base names — both are minifier artifacts
  // e.g. NZ(h.boolean().optional()) → wrapper=NZ, zodBase=h
  const lineText = code.slice(lineStart, durableEnd);
  const wrapperMatch = lineText.match(/(\w+)\((\w+)\.boolean\(\)\.optional\(\)\)/);
  if (!wrapperMatch) return null;
  const wrapper = wrapperMatch[1];
  const zodBase = wrapperMatch[2];

  const permanentField = `,${indent}permanent: ${wrapper}(${zodBase}.boolean().optional()).describe("${PERMANENT_DESC}")`;

  return {
    code: code.slice(0, durableEnd) + permanentField + code.slice(durableEnd),
    changed: 1,
  };
}

/**
 * Injection 2: Add `permanent` to CronCreateTool call() destructuring
 * and pass through to addCronTask.
 *
 * Anchors: async call({ cron: ..., durable: ... }) near the schema,
 * followed by await XXX(cronVar, promptVar, ..., ?.agentId)
 */
function injectCall(code) {
  // Find the call() by the unique CronCreate input schema marker we just patched.
  // After injection 1 runs, the schema contains the PERMANENT_DESC string.
  const anchor = code.indexOf(PERMANENT_DESC);
  if (anchor === -1) return null;

  // Search forward for the call() destructuring.
  const searchWindow = code.slice(anchor, anchor + 3000);
  const callMatch = searchWindow.match(
    /async call\(\{[\s\S]*?cron:\s*([\w$]+),[\s\S]*?prompt:\s*([\w$]+),[\s\S]*?recurring:\s*([\w$]+)\s*=\s*true,[\s\S]*?durable:\s*([\w$]+)\s*=\s*false[\s\S]*?\}\)\s*\{/
  );
  if (!callMatch) return null;

  const cronVar = callMatch[1];
  const promptVar = callMatch[2];
  const recurringVar = callMatch[3];
  const durableVar = callMatch[4];
  const absCallStart = anchor + callMatch.index;
  const absCallEnd = absCallStart + callMatch[0].length;

  // Find the addCronTask await — two forms observed:
  //   Old: let O = K && fn(); let T = await addCron(H, _, q, O, X?.agentId)
  //   New: let O = K && $3H(); let T = await VoH(H, _, q, O, KZ()?.agentId)
  // Both: let <var> = <durable> && <expr>(); let <var2> = await <fn>(<cron>, <prompt>, <recurring>, <durableResolved>, <expr>?.agentId)
  const afterCall = code.slice(absCallEnd, absCallEnd + 500);
  const awaitMatch = afterCall.match(
    new RegExp(
      `let ([\\w$]+) = ${durableVar} && ([\\w$]+)\\(\\);\\s*let ([\\w$]+) = await ([\\w$]+)\\(${cronVar}, ${promptVar}, ${recurringVar}, ([\\w$]+), ([\\w$]+)\\(\\)\\?\\.agentId\\)`
    )
  );
  if (!awaitMatch) return null;

  const effectiveDurable = awaitMatch[1];
  const isDurableFn = awaitMatch[2];
  const resultVar = awaitMatch[3];
  const addCronFn = awaitMatch[4];
  const durableArg = awaitMatch[5];
  const agentIdGetter = awaitMatch[6];
  const absAwaitStart = absCallEnd + awaitMatch.index;
  const absAwaitEnd = absAwaitStart + awaitMatch[0].length;

  // Build the replacement call() destructuring with permanent added
  const origCall = callMatch[0];
  const newCall = origCall.replace(
    /durable:\s*([\w$]+)\s*=\s*false[\s\S]*?\}\)\s*\{/,
    "durable: $1 = false,\n        permanent: Pm = false\n      }) {"
  );

  // Build the replacement await with Pm passed as extra arg
  const newAwait = `let ${effectiveDurable} = ${durableVar} && ${isDurableFn}();\n        let ${resultVar} = await ${addCronFn}(${cronVar}, ${promptVar}, ${recurringVar}, ${durableArg}, ${agentIdGetter}()?.agentId, Pm)`;

  let newCode =
    code.slice(0, absCallStart) +
    newCall +
    afterCall.slice(0, awaitMatch.index) +
    newAwait +
    code.slice(absAwaitEnd);

  return { code: newCode, changed: 1 };
}

/**
 * Injection 3: Modify addCronTask to accept and persist `permanent` parameter.
 *
 * Anchors: createdBySessionId (unique to durable cron task creation),
 * randomUUID().slice(0, 8) in the same function for task ID.
 */
function injectAddCronTask(code) {
  // Find the durable cron push — unique pattern: createdByPid: process.pid
  const pidIdx = code.indexOf("createdByPid: process.pid");
  if (pidIdx === -1) return null;

  // Walk backward to find the randomUUID() pattern in the same function
  const before = code.slice(Math.max(0, pidIdx - 2000), pidIdx);
  const uuidMatch = before.match(/randomUUID\(\)\.slice\(0,\s*8\)/);
  if (!uuidMatch) return null;

  const uuidOffset = Math.max(0, pidIdx - 2000) + uuidMatch.index;

  // Locate the enclosing async function from the UUID anchor; accept both
  // five- and six-parameter signatures.
  const fnBefore = code.slice(Math.max(0, uuidOffset - 500), uuidOffset);
  const fnMatch = fnBefore.match(
    /async function ([\w$]+)\(([\w$]+(?:,\s*[\w$]+){4,5})\)\s*\{/
  );
  if (!fnMatch) return null;

  const fnSig = fnMatch[0];
  const fnStart = Math.max(0, uuidOffset - 500) + fnMatch.index;

  // Add Pm parameter to function signature
  const newSig = fnSig.replace(/\)\s*\{$/, ", Pm) {");

  // Find the push({...createdByPid: process.pid...}) — the durable write.
  // Two forms:
  //   Old: z.push({ ...$, createdBySessionId: FN(), createdByPid: process.pid, createdByProcStart: FN() })
  //   New: $.push({ ...z, createdBySessionId: FN(), createdByPid: process.pid, createdByProcStart: FN() })
  const afterFn = code.slice(fnStart, fnStart + 1500);
  const pushMatch = afterFn.match(
    /[\w$]+\.push\(\{\s*\.\.\.[\w$]+,\s*createdBySessionId:\s*[\w$]+\(\),\s*createdByPid:\s*process\.pid,\s*createdByProcStart:\s*[\w$]+\(\)\s*\}\)/
  );
  if (!pushMatch) return null;

  const pushStart = fnStart + pushMatch.index;
  const pushEnd = pushStart + pushMatch[0].length;

  // Add permanent to the push object, guarded by __isModEnabled__
  const newPush = pushMatch[0].replace(
    /createdByProcStart:\s*([\w$]+)\(\)\s*\}\)$/,
    "createdByProcStart: $1(),\n      ...(typeof __isModEnabled__ === \"function\" && __isModEnabled__(\"unlock_permanent_cron\") && Pm && { permanent: true })\n    })"
  );

  let newCode =
    code.slice(0, fnStart) +
    newSig +
    afterFn.slice(fnSig.length, pushMatch.index) +
    newPush +
    code.slice(pushEnd);

  return { code: newCode, changed: 1 };
}

function transform(code) {
  let result = code;
  let totalChanges = 0;

  const schemaResult = injectSchema(result);
  if (schemaResult) {
    result = schemaResult.code;
    totalChanges += schemaResult.changed;
    console.error(`[unlock-permanent-cron] Schema: added permanent field`);
  } else {
    console.error(`[unlock-permanent-cron] Schema: FAILED to match`);
    return { code, changed: 0 };
  }

  const callResult = injectCall(result);
  if (callResult) {
    result = callResult.code;
    totalChanges += callResult.changed;
    console.error(`[unlock-permanent-cron] call(): added permanent param`);
  } else {
    console.error(`[unlock-permanent-cron] call(): FAILED to match`);
    return { code, changed: 0 };
  }

  const fnResult = injectAddCronTask(result);
  if (fnResult) {
    result = fnResult.code;
    totalChanges += fnResult.changed;
    console.error(`[unlock-permanent-cron] addCronTask: added permanent param`);
  } else {
    console.error(`[unlock-permanent-cron] addCronTask: FAILED to match`);
    return { code, changed: 0 };
  }

  return { code: result, changed: totalChanges };
}

if (require.main === module) {
  const inputPath = process.argv[2];
  const outputPath = process.argv[3];
  if (!inputPath) {
    console.error("Usage: node codemod-unlock-permanent-cron.cjs <input> [output]");
    process.exit(1);
  }
  const code = fs.readFileSync(inputPath, "utf-8");
  const { code: out, changed } = transform(code);
  if (outputPath) {
    fs.writeFileSync(outputPath, out, "utf-8");
  } else {
    process.stdout.write(out);
  }
  console.error(`[unlock-permanent-cron] ${changed} injections applied`);
  process.exit(changed > 0 ? 0 : 1);
}

module.exports = { transform };

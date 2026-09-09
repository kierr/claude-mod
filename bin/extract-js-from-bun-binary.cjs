#!/usr/bin/env node
/**
 * Extract JavaScript source from a compiled Bun binary.
 *
 * Bun binaries store the full JS source (even when bytecode is compiled) in
 * the __BUN,__bun Mach-O section (macOS) or .bun ELF section (Linux).
 *
 * Binary layout (reverse-engineered from Bun's Zig source + tweakcc):
 *
 *   [u32 or u64 size header][Bun data blob]
 *
 * Bun data blob:
 *   [string data...][module table][OFFSETS struct (32 bytes)][TRAILER]
 *
 * OFFSETS struct (32 bytes, all little-endian):
 *   byteCount:        u64   (total blob size including trailer)
 *   modulesPtr:       { u32 offset, u32 length }  (8 bytes)
 *   entryPointId:     u32   (index into module table)
 *   compileExecArgv:  { u32 offset, u32 length }  (8 bytes)
 *   flags:            u32
 *
 * Module struct (52 bytes for Bun >= 1.3.7, 36 bytes older):
 *   name:      StringPointer (u32 offset, u32 length) — 8 bytes
 *   contents:  StringPointer (u32 offset, u32 length) — 8 bytes
 *   sourcemap: StringPointer (u32 offset, u32 length) — 8 bytes
 *   bytecode:  StringPointer (u32 offset, u32 length) — 8 bytes
 *   ... remaining fields (20 bytes for 52-byte struct)
 *
 * Trailer: \n---- Bun! ----\n
 *
 * References:
 *   - https://github.com/Piebald-AI/tweakcc (LIEF-based extraction)
 *   - Bun Zig source: src/bun.js/api/bun/compile.ts
 */

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const MODULE_SIZE_NEW = 52;
const MODULE_SIZE_OLD = 36;
const OFFSETS_SIZE = 32;
const TRAILER = "\n---- Bun! ----\n";

// Detect platform binary type
function getPlatformInfo() {
  const platform = process.platform;
  const arch = process.arch;

  if (platform === "darwin") {
    return {
      platform,
      arch,
      section: "__BUN",
      segment: "__bun",
      tool: "otool",
    };
  } else if (platform === "linux") {
    return {
      platform,
      arch,
      section: ".bun",
      segment: null,
      tool: "objcopy",
    };
  } else if (platform === "win32") {
    throw new Error(
      `Windows native binary extraction is not yet supported — ` +
      `patching on Windows is disabled for versions >= 2.1.113. ` +
      `Use WSL or patch on macOS/Linux instead.`
    );
  } else {
    throw new Error(`Unsupported platform: ${platform}`);
  }
}

/**
 * Get the file offset and size of a Mach-O section via `otool -l`.
 * Returns { offset, size } in bytes.
 */
function getMachoSectionInfo(binaryPath, segmentName, sectionName) {
  const stdout = execFileSync("otool", ["-l", binaryPath], {
    stdio: "pipe",
    maxBuffer: 50 * 1024 * 1024,
  }).toString("utf8");

  const lines = stdout.split("\n");
  let inTargetSection = false;
  let offset = null;
  let size = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();

    if (line === `sectname ${sectionName}`) {
      // segname can appear before OR after sectname in otool -l output
      for (let j = Math.max(0, i - 10); j < Math.min(lines.length, i + 3); j++) {
        if (lines[j].trim() === `segname ${segmentName}`) {
          inTargetSection = true;
          break;
        }
      }
    }

    if (inTargetSection) {
      const offsetMatch = line.match(/^offset (\d+)$/);
      if (offsetMatch) offset = parseInt(offsetMatch[1], 10);

      const sizeMatch = line.match(/^size (0x[0-9a-fA-F]+|\d+)$/);
      if (sizeMatch) size = parseInt(sizeMatch[1], sizeMatch[1].startsWith("0x") ? 16 : 10);

      if (offset !== null && size !== null) {
        return { offset, size };
      }
    }
  }

  throw new Error(`Section ${segmentName},${sectionName} not found in Mach-O headers`);
}

/**
 * Extract __BUN section by reading raw bytes directly from the binary file.
 * Uses otool -l to find the section offset/size, then streams bytes out.
 * Much faster and lower memory than parsing the otool hex dump — the
 * old approach buffered 500+ MB of hex text and hit V8 array limits.
 */
function extractSectionMac(binaryPath, outputPath, arch) {
  const tmpOutput = `${outputPath}.tmp`;

  try {
    const { offset, size } = getMachoSectionInfo(binaryPath, "__BUN", "__bun");
    console.error(`  Mach-O section: offset=${offset}, size=${size} (${Math.round(size / 1024 / 1024)} MB)`);

    const readable = fs.createReadStream(binaryPath, { start: offset, end: offset + size - 1 });
    const writable = fs.createWriteStream(tmpOutput);

    return new Promise((resolve, reject) => {
      readable.on("error", reject);
      writable.on("error", reject);
      writable.on("finish", () => resolve(tmpOutput));
      readable.pipe(writable);
    });
  } catch (error) {
    throw new Error(`Failed to extract Mach-O section: ${error.message}`);
  }
}

// Extract .bun section using objcopy (Linux) — returns correct byte order natively
function extractSectionLinux(binaryPath, outputPath) {
  const tmpOutput = `${outputPath}.tmp`;

  try {
    execFileSync("objcopy", [
      "--only-section=.bun",
      "--output-target=binary",
      binaryPath,
      tmpOutput,
    ], { stdio: "pipe" });
    return tmpOutput;
  } catch (error) {
    throw new Error(`Failed to extract section with objcopy: ${error.message}`);
  }
}

/**
 * Parse the OFFSETS struct (32 bytes immediately before the trailer).
 * All fields are little-endian.
 */
function parseOffsets(buffer, offsetsStart) {
  return {
    byteCount: buffer.readBigUInt64LE(offsetsStart),
    modulesPtr: {
      offset: buffer.readUInt32LE(offsetsStart + 8),
      length: buffer.readUInt32LE(offsetsStart + 12),
    },
    entryPointId: buffer.readUInt32LE(offsetsStart + 16),
    compileExecArgv: {
      offset: buffer.readUInt32LE(offsetsStart + 20),
      length: buffer.readUInt32LE(offsetsStart + 24),
    },
    flags: buffer.readUInt32LE(offsetsStart + 28),
  };
}

/**
 * Parse a module entry at the given offset.
 * Returns the four StringPointer fields: name, contents, sourcemap, bytecode.
 */
function parseModule(buffer, offset) {
  const readStrPtr = (off) => ({
    offset: buffer.readUInt32LE(off),
    length: buffer.readUInt32LE(off + 4),
  });
  return {
    name: readStrPtr(offset),
    contents: readStrPtr(offset + 8),
    sourcemap: readStrPtr(offset + 16),
    bytecode: readStrPtr(offset + 24),
  };
}

/**
 * Detect module struct size by checking which divides evenly into the
 * modules list byte length.
 */
function detectModuleSize(modulesByteLength) {
  const fitsNew = modulesByteLength % MODULE_SIZE_NEW === 0;
  const fitsOld = modulesByteLength % MODULE_SIZE_OLD === 0;
  if (fitsNew && fitsOld) {
    // Ambiguous — prefer new (52-byte) format as Bun >= 1.3.7
    return MODULE_SIZE_NEW;
  }
  if (fitsNew) return MODULE_SIZE_NEW;
  if (fitsOld) return MODULE_SIZE_OLD;
  throw new Error(
    `Module table byte length ${modulesByteLength} is not divisible by ` +
    `${MODULE_SIZE_NEW} or ${MODULE_SIZE_OLD}`
  );
}

/**
 * Strip the size header that precedes the Bun data blob.
 * The header is either u32 (old Bun < 1.3.4) or u64 (newer).
 * Returns { headerSize, blobOffset } where blobOffset points to the data.
 *
 * Detection heuristic: headerSize + byteCount should be close to sectionLength.
 * The 4096-byte tolerance accounts for section alignment padding that Mach-O/ELF
 * may add beyond the logical data size. u64 is checked first because an 8-byte
 * header at offset 0 is the most common format (Bun >= 1.3.4); u32 is the older
 * format. If neither matches, the section is assumed to contain the blob directly
 * with no size header.
 */
function detectHeaderSize(sectionBuffer, trailerOffset, offsets) {
  // byteCount from OFFSETS is the total blob size including trailer.
  // If section starts with a size header, the blob starts after it.
  const byteCount = Number(offsets.byteCount);

  // Check u64 header (8 bytes): headerSize + byteCount ≈ sectionLength
  const sectionLen = sectionBuffer.length;
  if (8 + byteCount <= sectionLen && sectionLen - (8 + byteCount) < 4096) {
    return 8;
  }
  // Check u32 header (4 bytes)
  if (4 + byteCount <= sectionLen && sectionLen - (4 + byteCount) < 4096) {
    return 4;
  }
  // No header — blob starts at offset 0
  return 0;
}

/**
 * Parse the Bun section payload and extract main module JS.
 *
 * The section contains: [optional size header][blob: data + module table + OFFSETS + trailer]
 * We find the trailer, read OFFSETS, locate the module table, and extract
 * the entry point module's contents.
 */
function parseBunSection(sectionBuffer) {
  if (sectionBuffer.length < OFFSETS_SIZE + TRAILER.length) {
    throw new Error(`Section too small: ${sectionBuffer.length} bytes`);
  }

  // Find trailer at end of section
  const trailerBuf = Buffer.from(TRAILER, "utf8");
  const trailerOffset = sectionBuffer.lastIndexOf(trailerBuf);

  if (trailerOffset === -1) {
    throw new Error("Trailer not found in payload");
  }

  // OFFSETS struct is the 32 bytes immediately before the trailer
  if (trailerOffset < OFFSETS_SIZE) {
    throw new Error("No space for OFFSETS struct before trailer");
  }

  const offsetsStart = trailerOffset - OFFSETS_SIZE;
  const offsets = parseOffsets(sectionBuffer, offsetsStart);

  // Detect and skip the size header to find the blob base
  const headerSize = detectHeaderSize(sectionBuffer, trailerOffset, offsets);
  const blobBase = headerSize;

  // Logical blob end: blobBase + byteCount (the actual data size from OFFSETS).
  // Use this instead of sectionBuffer.length for bounds checks, because
  // sectionBuffer may include alignment padding beyond the logical blob.
  const logicalBlobEnd = blobBase + Number(offsets.byteCount);

  // Sanity: logicalBlobEnd must not exceed actual section size. A corrupted
  // byteCount could make bounds checks against logicalBlobEnd meaningless.
  if (logicalBlobEnd > sectionBuffer.length || logicalBlobEnd < blobBase) {
    throw new Error(
      `Blob bounds invalid: blobBase=${blobBase}, blobEnd=${logicalBlobEnd}, sectionSize=${sectionBuffer.length}`
    );
  }

  // Module table is at blobBase + offsets.modulesPtr.offset
  const modulesOffset = blobBase + offsets.modulesPtr.offset;
  const modulesByteLength = offsets.modulesPtr.length;
  const moduleSize = detectModuleSize(modulesByteLength);
  const moduleCount = modulesByteLength / moduleSize;

  // Validate module table is within logical blob bounds
  if (modulesOffset + modulesByteLength > logicalBlobEnd) {
    throw new Error(
      `Module table extends beyond blob: offset=${modulesOffset}, ` +
      `length=${modulesByteLength}, blobEnd=${logicalBlobEnd}`
    );
  }

  console.error(`  header: ${headerSize} bytes, blob base: ${blobBase}`);
  console.error(`  modules: offset=${modulesOffset}, length=${modulesByteLength}, ` +
    `count=${moduleCount}, struct=${moduleSize} bytes`);
  console.error(`  entry point: module index ${offsets.entryPointId}`);

  if (offsets.entryPointId >= moduleCount) {
    throw new Error(
      `Entry point index ${offsets.entryPointId} >= module count ${moduleCount}`
    );
  }

  // Extract the entry point module's contents
  const mod = parseModule(sectionBuffer, modulesOffset + offsets.entryPointId * moduleSize);
  const contentsOffset = blobBase + mod.contents.offset;
  const contentsLength = mod.contents.length;

  if (contentsOffset + contentsLength > logicalBlobEnd) {
    throw new Error(
      `Contents extends beyond blob: offset=${contentsOffset}, ` +
      `length=${contentsLength}, blobEnd=${logicalBlobEnd}`
    );
  }

  const jsSource = sectionBuffer.subarray(contentsOffset, contentsOffset + contentsLength).toString("utf8");
  return jsSource;
}

// Main extraction flow
async function extractJS(binaryPath, outputPath) {
  if (!fs.existsSync(binaryPath)) {
    throw new Error(`Binary not found: ${binaryPath}`);
  }

  const info = getPlatformInfo();
  console.error(`Extracting from ${info.platform}-${info.arch} binary...`);

  // Step 1: Extract the __BUN/.bun section from the binary
  let sectionPath;
  if (info.platform === "darwin") {
    sectionPath = await extractSectionMac(binaryPath, outputPath, info.arch);
  } else {
    sectionPath = extractSectionLinux(binaryPath, outputPath);
  }

  try {
    // Step 2: Parse the section and extract JS
    const sectionBuffer = fs.readFileSync(sectionPath);
    console.error(`Section size: ${sectionBuffer.length} bytes`);

    const jsSource = parseBunSection(sectionBuffer);
    console.error(`Extracted JS: ${jsSource.length} bytes, ${jsSource.split("\n").length} lines`);

    // Step 3: Write to output
    fs.writeFileSync(outputPath, jsSource, "utf8");
    console.error(`Wrote: ${outputPath}`);

    return outputPath;
  } finally {
    if (sectionPath && sectionPath !== outputPath && fs.existsSync(sectionPath)) {
      fs.unlinkSync(sectionPath);
    }
  }
}

// CLI
if (require.main === module) {
  if (process.argv.length < 4) {
    console.error("Usage: node extract-js-from-bun-binary.cjs <binary> <output.js>");
    process.exit(1);
  }

  const binaryPath = process.argv[2];
  const outputPath = process.argv[3];

  extractJS(binaryPath, outputPath).catch((error) => {
    console.error(`Error: ${error.message}`);
    process.exit(1);
  });
}

module.exports = { extractJS, parseBunSection, getPlatformInfo };

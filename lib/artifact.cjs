const fs = require("fs");
const path = require("path");
const { createHash } = require("crypto");
const ROOT = path.join(__dirname, "..");

function sha256File(file) {
  const hash = createHash("sha256");
  const fd = fs.openSync(file, "r");
  try {
    const buf = Buffer.alloc(1 << 20);
    let n;
    while ((n = fs.readSync(fd, buf, 0, buf.length)) > 0) hash.update(buf.subarray(0, n));
    return hash.digest("hex");
  } finally { fs.closeSync(fd); }
}

function patchSetFingerprint() {
  const hash = createHash("sha256");
  function include(dir) {
    for (const entry of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name === "node_modules") continue;
      const relative = path.join(dir, entry.name);
      if (entry.isDirectory()) include(relative);
      else if (/\.(cjs|js|json|yaml)$/.test(entry.name)) {
        hash.update(relative);
        hash.update("\0");
        hash.update(fs.readFileSync(path.join(ROOT, relative)));
        hash.update("\0");
      }
    }
  }
  for (const dir of ["patches", "codemods", "lib", "bin"]) include(dir);
  return hash.digest("hex");
}

function stampArtifact(dir, version, details) {
  const manifest = { ...details, schema: 1, version, status: "complete",
    outputSha: sha256File(path.join(dir, "deobfuscated.js")),
    at: new Date().toISOString() };
  fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify(manifest, null, 2));
  return manifest;
}

function validateArtifact(dir, version, requireCurrent = true) {
  const file = path.join(dir, "deobfuscated.js");
  let manifest;
  try { manifest = JSON.parse(fs.readFileSync(path.join(dir, "manifest.json"), "utf8")); }
  catch { throw new Error(`Missing successful patch manifest; re-patch ${version}`); }
  if (manifest.schema !== 1 || manifest.version !== version || manifest.status !== "complete"
      || !Array.isArray(manifest.skipped) || !Number.isInteger(manifest.applied)
      || manifest.applied < 0 || !/^[a-f0-9]{64}$/.test(manifest.baselineSha)
      || !/^[a-f0-9]{64}$/.test(manifest.patchSetSha)
      || manifest.outputSha !== sha256File(file)) {
    throw new Error(`Invalid or changed patch artifact; re-patch ${version}`);
  }
  if (requireCurrent && manifest.patchSetSha !== patchSetFingerprint()) {
    throw new Error(`Patch recipe changed; re-patch ${version}`);
  }
  const fd = fs.openSync(file, "r");
  try {
    const header = Buffer.alloc(Buffer.byteLength("#!/usr/bin/env bun\n"));
    fs.readSync(fd, header, 0, header.length, 0);
    if (header.toString() !== "#!/usr/bin/env bun\n") throw new Error("Missing Bun shebang; re-patch required");
  } finally { fs.closeSync(fd); }
  return manifest;
}

module.exports = { sha256File, patchSetFingerprint, stampArtifact, validateArtifact };

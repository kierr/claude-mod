import { test, expect } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const pipeline = path.resolve(import.meta.dir, '../../bin/webcrack-pipeline.cjs');
function runPipeline(source, version = '2.15.1') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'webcrack-contract-'));
  const out = path.join(dir, 'out');
  fs.writeFileSync(path.join(dir, 'input.js'), 'console.log("synthetic");\n');
  fs.writeFileSync(path.join(dir, 'webcrack'), `#!${process.execPath}\nconst fs=require('fs'),path=require('path');
if(process.argv.includes('--version')){ console.log(${JSON.stringify(version)});process.exit(0); }
const out=process.argv[process.argv.indexOf('-o')+1];fs.mkdirSync(out,{recursive:true});
fs.writeFileSync(path.join(out,'deobfuscated.js'),${JSON.stringify(source)});\n`, { mode: 0o755 });
  try {
    const result = spawnSync('node', [pipeline, path.join(dir, 'input.js'), '-o', out], {
      env: { ...process.env, PATH: `${dir}${path.delimiter}${process.env.PATH}`, WEBCRACK_RUNNER: 'webcrack' },
      encoding: 'utf8', timeout: 30000,
    });
    return { ...result, output: fs.existsSync(path.join(out, 'deobfuscated.js')) ? fs.readFileSync(path.join(out, 'deobfuscated.js'), 'utf8') : null };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('preserves valid synthetic nested templates and escaped prose byte-for-byte', () => {
  const source = 'const name = "example";\nconst value = `outer ${`inner ${name}`} and \\`literal\\``;\n';
  const result = runPipeline(source);
  expect(result.status).toBe(0);
  expect(result.output).toBe(source);
});

test('rejects invalid producer output without attempting repairs', () => {
  const source = 'const value = `unterminated;\n';
  const result = runPipeline(source);
  expect(result.status).toBe(1);
  expect(result.stderr).toContain('output is invalid');
  expect(result.output).toBe(source);
});

test('explicit global runner must match the verified version', () => {
  const result = runPipeline('const value = 1;\n', '99.0.0');
  expect(result.status).toBe(1);
  expect(result.stderr).toContain('2.15.1 required');
  expect(result.output).toBeNull();
});

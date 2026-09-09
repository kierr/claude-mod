import { describe, test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const root = path.resolve(import.meta.dir, '../..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

describe('public release contracts', () => {
  test('singular unscoped package, executable, repository, and installer agree', () => {
    const pkg = JSON.parse(read('package.json'));
    expect(pkg.name).toBe('claude-mod');
    expect(pkg.bin).toEqual({ 'claude-mod': 'bin/patch.cjs' });
    expect(pkg.repository.url).toBe('git+https://github.com/kierr/claude-mod.git');
    expect(read('install.sh')).toContain('PKG="claude-mod"');
    expect(read('install.sh')).toContain('REPO="kierr/claude-mod"');
    expect(read('README.md')).toContain('git clone https://github.com/kierr/claude-mod.git');
    expect(read('bin/gate-fresh-install.cjs')).toContain('path.join(home, ".bun", "bin", "claude-mod")');
  });

  test('the CLI rename preserves existing on-disk state and launcher ownership', () => {
    expect(read('bin/patch.cjs')).toContain('path.join(os.homedir(), ".cache", "claude-mods")');
    expect(read('lib/installation.cjs')).toContain('path.join(home, ".local", "lib", "claude-mods")');
    expect(read('bin/discover-env-vars.cjs')).toContain('".cache", "claude-mods"');
    expect(read('README.md')).toContain('State directories retain the legacy `claude-mods` name');
  });
  test('npm preserves pipeline dependencies and the verified producer pin', () => {
    const pkg = JSON.parse(read('package.json'));
    const pipeline = read('bin/webcrack-pipeline.cjs');
    const helpers = [...pipeline.matchAll(/path\.join\(__dirname, "([^"]+\.cjs)"\)/g)].map((m) => `bin/${m[1]}`);
    expect(pipeline).not.toContain('fix-backtick');
    expect(pkg.files.some((file) => file.includes('fix-backtick'))).toBe(false);
    expect(read('install.sh')).toContain('webcrack@2.15.1');
    expect(pipeline).toContain('const WEBCRACK_VERSION = "2.15.1";');
    for (const helper of helpers) {
      expect(pkg.files).toContain(helper);
      expect(fs.existsSync(path.join(root, helper))).toBe(true);
    }
  });

  test('npm excludes locally discovered catalogs', () => {
    const pkg = JSON.parse(read('package.json'));
    expect(pkg.files).not.toContain('patches/');
    expect(pkg.files).toContain('patches/*.yaml');
    expect(pkg.files).toContain('patches/env-catalog.json');
    const packed = JSON.parse(execFileSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], {
      cwd: root, encoding: 'utf8', timeout: 30000,
      env: { ...process.env, npm_config_update_notifier: 'false' },
    }))[0].files.map((entry) => entry.path);
    expect(packed).toContain('patches/env-catalog.json');
    expect(packed.filter((file) => file.endsWith('.yaml')).length).toBe(44);
    expect(packed.some((file) => file.includes('.discovered.'))).toBe(false);
  });

  test('default updates use the packaged verification pin, not npm latest', () => {
    const cli = read('bin/patch.cjs');
    expect(cli).toContain('const target = version || validateVersion(fs.readFileSync(VERSION_FILE, "utf8").trim());');
    expect(cli).not.toContain('getLatestUpstreamVersion');
    expect(read('last-tested-version').trim()).toBe('2.1.181');
  });

  test('publication depends on source checks and does not auto-promote upstream', () => {
    const workflow = read('.github/workflows/ci.yml');
    expect(workflow).toMatch(/publish:\n\s+needs: checks/);
    expect(workflow).not.toContain('schedule:');
    expect(workflow).not.toContain('compat-update');
    expect(workflow).not.toContain('actions/cache');
  });
});

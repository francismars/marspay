import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';

const srcDir = path.resolve(import.meta.dirname);

const serverModuleImport =
  /\bfrom\s+['"](?:\.\.?\/)+server(?:\.[jt]s)?['"]|\brequire\(\s*['"](?:\.\.?\/)+server(?:\.[jt]s)?['"]\s*\)|\bimport\(\s*['"](?:\.\.?\/)+server(?:\.[jt]s)?['"]\s*\)|\bvi\.mock\(\s*['"](?:\.\.?\/)+server(?:\.[jt]s)?['"]/;

function typescriptFilesUnder(dir: string): string[] {
  const files: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...typescriptFilesUnder(fullPath));
    } else if (entry.isFile() && entry.name.endsWith('.ts')) {
      files.push(fullPath);
    }
  }
  return files;
}

describe('server module import', () => {
  it('does not listen when the app and io modules are imported', async () => {
    const listen = vi.spyOn(http.Server.prototype, 'listen').mockImplementation(function (
      this: http.Server
    ) {
      return this;
    });

    try {
      await import('./app');
      await import('./io');
      await new Promise((resolve) => setImmediate(resolve));
      expect(listen).not.toHaveBeenCalled();
    } finally {
      listen.mockRestore();
    }
  }, 20_000);

  it('does not import the server entry from any other source file', () => {
    const offenders = typescriptFilesUnder(srcDir)
      .filter((file) => path.basename(file) !== 'server.ts')
      .filter((file) => serverModuleImport.test(fs.readFileSync(file, 'utf8')))
      .map((file) => path.relative(srcDir, file));

    expect(offenders).toEqual([]);
  });
});

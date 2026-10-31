import http from 'node:http';
import { describe, expect, it, vi } from 'vitest';

vi.mock('./telemetry/eventLog', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./telemetry/eventLog')>();
  return {
    ...actual,
    warmEventLog: () => Promise.resolve(),
  };
});

describe('server module import', () => {
  it('does not listen unless this file is the process entry', async () => {
    const listen = vi.spyOn(http.Server.prototype, 'listen').mockImplementation(function (
      this: http.Server
    ) {
      return this;
    });

    try {
      const { isServerEntrypoint } = await import('./server');
      await import('./app');
      await new Promise((resolve) => setImmediate(resolve));

      expect(isServerEntrypoint('/srv/marspay/dist/server.js')).toBe(true);
      expect(isServerEntrypoint('/srv/marspay/src/server.ts')).toBe(true);
      expect(isServerEntrypoint(undefined)).toBe(false);
      expect(isServerEntrypoint('/usr/bin/vitest')).toBe(false);
      expect(isServerEntrypoint(process.argv[1])).toBe(false);
      expect(listen).not.toHaveBeenCalled();
    } finally {
      listen.mockRestore();
    }
  }, 20_000);
});

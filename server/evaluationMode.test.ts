import express from 'express';
import type { AddressInfo } from 'node:net';
import { describe, expect, it, vi, afterEach } from 'vitest';
import { registerChequeRoutes } from './chequeRoutes';

describe('EVALUATION_MODE runtime configuration', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('reports evaluation mode through the lightweight health endpoint', async () => {
    vi.stubEnv('EVALUATION_MODE', 'true');
    expect(process.env.EVALUATION_MODE).toBe('true');
    const app = express();
    registerChequeRoutes(app);
    const server = app.listen(0);
    try {
      const address = server.address() as AddressInfo;
      const response = await fetch(`http://127.0.0.1:${address.port}/api/healthz`);
      const payload = await response.json() as { evaluationMode?: boolean };
      expect(response.ok).toBe(true);
      expect(payload.evaluationMode).toBe(true);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

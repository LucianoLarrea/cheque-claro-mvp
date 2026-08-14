import express from 'express';
import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import { registerChequeRoutes } from './chequeRoutes';

describe('Evaluation API endpoints', () => {
  it('permite enviar ground truth y consultar estadísticas cuando EVALUATION_MODE=true', async () => {
    process.env.EVALUATION_MODE = 'true';
    const app = express();
    app.use(express.json());
    registerChequeRoutes(app);
    const server = app.listen(0);
    try {
      const address = server.address() as AddressInfo;
      const baseUrl = `http://127.0.0.1:${address.port}`;

      const postRes = await fetch(`${baseUrl}/api/evaluation`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          data: {
            cuit: '20-92455045-5',
            cuit_evidence: '20-92455045-5',
            cheque_numero: '65764032',
            cheque_numero_evidence: '65764032',
            banco: 'Banco de Galicia',
            importe: 2500000,
            importe_evidence: '$ 2.500.000',
            moneda: 'ARS',
            fecha_pago: '2026-09-15',
            fecha_evidence: '15/09/2026',
            librador: 'SALLAS C.E.A.',
            confidence: { cuit: 0.95, cheque_numero: 0.98, banco: 0.94, importe: 0.96, fecha_pago: 0.95, librador: 0.92 },
          },
          groundTruth: {
            cuit: '20-92455045-5',
            cheque_numero: '65764032',
            importe: '2500000',
            fecha_pago: '2026-09-15',
          },
        }),
      });
      const postJson = await postRes.json() as any;
      expect(postRes.ok).toBe(true);
      expect(postJson.fields.cuit.correct).toBe(true);
      expect(postJson.fields.importe.evidence).toBe('$ 2.500.000');
      expect(postJson.stats.processedCheques).toBe(1);

      const statsRes = await fetch(`${baseUrl}/api/evaluation/stats`);
      const statsJson = await statsRes.json() as any;
      expect(statsRes.ok).toBe(true);
      expect(statsJson.stats.processedCheques).toBe(1);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { chequeRepository } from './services/chequeRepository';
import { SupabaseRestChequeRepository, PersistenceError } from './dbSupabaseRest';

describe('ChequeClaro Unified API & Persistence Comprehensive', () => {
  beforeEach(() => {
    vi.stubEnv('SUPABASE_URL', 'http://localhost:3000');
    vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'test-key');
    global.fetch = vi.fn().mockImplementation(async (url, options) => {
      if (options?.method === 'GET') {
        return { ok: true, json: async () => ([{ id: 'CHK-1234', timestamp: Date.now(), cuit: '20-12345678-6', cuits: [
          { cuit: '20-12345678-6', role: 'primary' },
          { cuit: '27-87654321-4', role: 'associated' }
        ], origin: 'whatsapp' }]) };
      }
      return { ok: true, json: async () => ([{ id: 'CHK-1234', timestamp: Date.now(), cuit: '20-12345678-6', cuits: [
        { cuit: '20-12345678-6', role: 'primary' },
        { cuit: '27-87654321-4', role: 'associated' }
      ], origin: 'whatsapp' }]) };
    }) as any;
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });
  it('should persist a cheque with multiple cuits and retrieve it by id', async () => {
    const mockCheque = {
      imageUrl: '',
      cuit: '20-12345678-6',
      cuitValidation: 'VALID' as const,
      chequeNumero: '00009999',
      banco: 'BANCO TEST',
      importe: 500000,
      moneda: 'ARS',
      fechaPago: '2026-09-15',
      librador: 'TEST EMPRESA S.A.',
      ocrText: 'TEST OCR',
      confidence: { cuit: 0.99, cheque_numero: 0.99, banco: 0.99, importe: 0.99, fecha_pago: 0.99, librador: 0.99 },
      extractionMode: 'gemini_vision',
      editedFields: [],
      cuits: [
        { cuit: '20-12345678-6', role: 'primary' as const, evidence: '20-12345678-6', validation: { valid: true }, bcra: { situacion_crediticia: 1 } },
        { cuit: '27-87654321-4', role: 'associated' as const, evidence: '27-87654321-4', validation: { valid: true }, bcra: { situacion_crediticia: 1 } },
      ],
      bcra: { situacion_crediticia: 1 },
      quote: { finalAmount: 480000 },
      origin: 'whatsapp' as const,
    };

    const saved = await chequeRepository.saveCheque(mockCheque);
    expect(saved).toBeDefined();
    expect(saved.id).toBeDefined();
    expect(saved.cuit).toBe('20-12345678-6');
    expect(saved.origin).toBe('whatsapp');

    const fetched = await chequeRepository.getCheque(saved.id);
    expect(fetched).toBeDefined();
    expect(fetched?.id).toBe(saved.id);
    expect(fetched?.cuits?.length).toBe(2);
    expect(fetched?.cuits?.[0].role).toBe('primary');
    expect(fetched?.cuits?.[1].role).toBe('associated');
  });

  it('should throw PersistenceError and NOT fallback to memory when Supabase fails', async () => {
    const repo = new SupabaseRestChequeRepository();
    vi.stubEnv('SUPABASE_URL', 'http://localhost:9999');
    vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'invalid-key');
    global.fetch = vi.fn().mockRejectedValue(new TypeError('fetch failed'));

    const badCheque = {
      imageUrl: '',
      cuit: '20-12345678-6',
      cuitValidation: 'VALID' as const,
      chequeNumero: '00001111',
      banco: 'BANCO FAIL',
      importe: 1000,
      moneda: 'ARS',
      fechaPago: '2026-09-15',
      librador: 'FAIL S.A.',
      ocrText: '',
      confidence: {},
      extractionMode: 'gemini_vision',
      editedFields: [],
      cuits: [],
      bcra: {},
      quote: null,
      origin: 'web' as const,
    };

    await expect(repo.saveCheque(badCheque)).rejects.toThrow(PersistenceError);
    vi.unstubAllEnvs();
  });
});

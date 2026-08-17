import { describe, expect, it, vi, afterEach, beforeEach } from 'vitest';
import { SupabaseRestChequeRepository } from './dbSupabaseRest';

function jsonResponse(body: any, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as Response;
}

const BASE_ROW = {
  id: 'CHK-TEST-1',
  timestamp: 1700000000000,
  image_url: '',
  cuit: '20-12345678-9',
  cuit_validation: 'VALID',
  cheque_numero: '00012345',
  banco: 'Banco Galicia',
  importe: 100000,
  moneda: 'ARS',
  fecha_pago: '2026-09-15',
  librador: 'Empresa Original S.A.',
  ocr_text: '',
  confidence: {},
  extraction_mode: 'gemini_vision',
  edited_fields: [],
  status: 'confirmado',
  bcra_result: {
    state: 'COMPLETED',
    snapshot: { cuit: '20-12345678-9', cheque_numero: '00012345', banco: 'Banco Galicia' },
    data: {
      titular_bcra: 'EMPRESA ORIGINAL SA',
      titular_coincide: true,
      situacion_crediticia: 1,
      periodo: '202606',
      cheques_rechazados: { cantidad: 0, detalle: [], estado: 'ok' },
      cheque_denunciado: { denunciado: false, detalle: [], estado: 'no_encontrado' },
      entidad_bcra: { codigoEntidad: 7, denominacion: 'BANCO GALICIA', estado: 'ok' },
      estados: { deudas: 'ok', cheques_rechazados: 'ok', entidad: 'ok', cheque_denunciado: 'no_encontrado' },
      nivel: 'sin_hallazgos',
    },
  },
  quote_result: { status: 'ready', porcentaje: 5, descuento: 5000, montoAPagar: 95000 },
};

function setupFetchMock(currentRow: any) {
  const calls: Array<{ url: string; method: string; body?: any }> = [];
  const fetchMock = vi.fn(async (url: string, options: any = {}) => {
    const method = options.method || 'GET';
    const body = options.body ? JSON.parse(options.body) : undefined;
    calls.push({ url, method, body });

    if (method === 'GET' && url.includes('/rest/v1/cheques?id=eq.')) {
      return jsonResponse([currentRow]);
    }
    if (method === 'POST' && url.includes('/rest/v1/cheque_corrections')) {
      return jsonResponse([{ ok: true }]);
    }
    if (method === 'PATCH' && url.includes('/rest/v1/cheques?id=eq.')) {
      const updatedRow = { ...currentRow, ...body };
      return jsonResponse([updatedRow]);
    }
    throw new Error(`Unexpected fetch call: ${method} ${url}`);
  });
  global.fetch = fetchMock as any;
  return { fetchMock, calls };
}

describe('updateCheque — wireado de Matriz de Invalidación (Fase 1B)', () => {
  beforeEach(() => {
    vi.stubEnv('SUPABASE_URL', 'https://example.supabase.co');
    vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'test-service-role-key');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('PATCH cambia cuit → bcra_result pasa a STALE, data null, snapshot nuevo', async () => {
    setupFetchMock(BASE_ROW);
    const repo = new SupabaseRestChequeRepository();
    const result = await repo.updateCheque('CHK-TEST-1', { cuit: '20-99999999-9' } as any);

    expect(result?.bcra.state).toBe('STALE');
    expect(result?.bcra.data).toBeNull();
    expect(result?.bcra.snapshot.cuit).toBe('20-99999999-9');
  });

  it('PATCH cambia solo librador → state no cambia, sin llamada HTTP a BCRA externo', async () => {
    const { calls } = setupFetchMock(BASE_ROW);
    const repo = new SupabaseRestChequeRepository();
    const result = await repo.updateCheque('CHK-TEST-1', { librador: 'Otro Titular SRL' } as any);

    expect(result?.bcra.state).toBe('COMPLETED');
    expect(result?.bcra.data).not.toBeNull();
    // Ninguna llamada debe apuntar a un host de BCRA.
    expect(calls.every((c) => !c.url.includes('bcra.gob.ar'))).toBe(true);
  });

  it('PATCH cambia importe → quote_result recalculado, bcra_result intacto', async () => {
    setupFetchMock(BASE_ROW);
    const repo = new SupabaseRestChequeRepository();
    const result = await repo.updateCheque('CHK-TEST-1', { importe: 200000 } as any);

    expect(result?.bcra.state).toBe('COMPLETED');
    expect(result?.bcra.snapshot.cuit).toBe('20-12345678-9');
    expect(result?.quote.status).toBe('ready');
  });

  it('PATCH con cuit igual al snapshot vigente → NO marca STALE', async () => {
    setupFetchMock(BASE_ROW);
    const repo = new SupabaseRestChequeRepository();
    const result = await repo.updateCheque('CHK-TEST-1', { cuit: '20-12345678-9' } as any);

    expect(result?.bcra.state).toBe('COMPLETED');
  });

  it('Mismatch preexistente snapshot vs cuit actual → STALE igual (defensa de snapshot)', async () => {
    const rowWithMismatch = {
      ...BASE_ROW,
      cuit: '20-11111111-1',
      bcra_result: {
        ...BASE_ROW.bcra_result,
        snapshot: { ...BASE_ROW.bcra_result.snapshot, cuit: '20-12345678-9' },
      },
    };
    setupFetchMock(rowWithMismatch);
    const repo = new SupabaseRestChequeRepository();
    // El PATCH ni siquiera toca cuit/chequeNumero/banco — solo librador — pero el
    // registro YA tenía un mismatch entre bcra.snapshot.cuit y el cuit vigente.
    // La defensa de snapshot debe forzar STALE de todos modos.
    const result = await repo.updateCheque('CHK-TEST-1', { librador: 'Otro Titular SRL' } as any);

    expect(result?.bcra.state).toBe('STALE');
  });
});

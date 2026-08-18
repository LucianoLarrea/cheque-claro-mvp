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
    state: 'NOT_STARTED',
    snapshot: { cuit: '20-12345678-9', cheque_numero: '00012345', banco: 'Banco Galicia' },
    data: {},
  },
  quote_result: { status: 'ready', porcentaje: 5, descuento: 5000, montoAPagar: 95000 },
};

const SNAPSHOT = { cuit: '20-12345678-9', cheque_numero: '00012345', banco: 'Banco Galicia' };

function setupFetchMock(currentRow: any) {
  const calls: Array<{ url: string; method: string; body?: any }> = [];
  const fetchMock = vi.fn(async (url: string, options: any = {}) => {
    const method = options.method || 'GET';
    const body = options.body ? JSON.parse(options.body) : undefined;
    calls.push({ url, method, body });

    if (method === 'GET' && url.includes('/rest/v1/cheques?id=eq.')) {
      return jsonResponse([currentRow]);
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

describe('applyBcraResult — job de background BCRA (Fase 1C)', () => {
  beforeEach(() => {
    vi.stubEnv('SUPABASE_URL', 'https://example.supabase.co');
    vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'test-service-role-key');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('arranque del job persiste RUNNING con data null antes de consultar BCRA', async () => {
    const { calls } = setupFetchMock(BASE_ROW);
    const repo = new SupabaseRestChequeRepository();

    const applied = await repo.applyBcraResult('CHK-TEST-1', { state: 'RUNNING', snapshot: SNAPSHOT });

    expect(applied).toBe(true);
    const patchCall = calls.find((c) => c.method === 'PATCH');
    expect(patchCall?.body.bcra_result.state).toBe('RUNNING');
    expect(patchCall?.body.bcra_result.data).toBeNull();
    expect(patchCall?.body.bcra_result.error).toBeUndefined();
  });

  it('cierre exitoso persiste COMPLETED con la data de BCRA', async () => {
    const runningRow = { ...BASE_ROW, bcra_result: { state: 'RUNNING', snapshot: SNAPSHOT, data: null } };
    const { calls } = setupFetchMock(runningRow);
    const repo = new SupabaseRestChequeRepository();

    const bcraData = { titular_bcra: 'EMPRESA ORIGINAL SA', nivel: 'sin_hallazgos' };
    const applied = await repo.applyBcraResult('CHK-TEST-1', { state: 'COMPLETED', snapshot: SNAPSHOT, data: bcraData });

    expect(applied).toBe(true);
    const patchCall = calls.find((c) => c.method === 'PATCH');
    expect(patchCall?.body.bcra_result.state).toBe('COMPLETED');
    expect(patchCall?.body.bcra_result.data).toEqual(bcraData);
  });

  it('falla de BCRA persiste FAILED con data null y campo error', async () => {
    const runningRow = { ...BASE_ROW, bcra_result: { state: 'RUNNING', snapshot: SNAPSHOT, data: null } };
    const { calls } = setupFetchMock(runningRow);
    const repo = new SupabaseRestChequeRepository();

    const applied = await repo.applyBcraResult('CHK-TEST-1', { state: 'FAILED', snapshot: SNAPSHOT, error: 'timeout' });

    expect(applied).toBe(true);
    const patchCall = calls.find((c) => c.method === 'PATCH');
    expect(patchCall?.body.bcra_result.state).toBe('FAILED');
    expect(patchCall?.body.bcra_result.data).toBeNull();
    expect(patchCall?.body.bcra_result.error).toBe('timeout');
  });

  it('estado distinto de FAILED nunca incluye el campo error', async () => {
    const { calls } = setupFetchMock(BASE_ROW);
    const repo = new SupabaseRestChequeRepository();

    await repo.applyBcraResult('CHK-TEST-1', { state: 'COMPLETED', snapshot: SNAPSHOT, data: { nivel: 'sin_hallazgos' } });

    const patchCall = calls.find((c) => c.method === 'PATCH');
    expect('error' in patchCall!.body.bcra_result).toBe(false);
  });

  it('snapshot no coincide con el cuit vigente → se descarta, no hay PATCH', async () => {
    const rowConCuitDistinto = { ...BASE_ROW, cuit: '20-99999999-9' };
    const { calls } = setupFetchMock(rowConCuitDistinto);
    const repo = new SupabaseRestChequeRepository();

    const applied = await repo.applyBcraResult('CHK-TEST-1', { state: 'COMPLETED', snapshot: SNAPSHOT, data: { nivel: 'sin_hallazgos' } });

    expect(applied).toBe(false);
    expect(calls.some((c) => c.method === 'PATCH')).toBe(false);
  });

  it('snapshot no coincide en chequeNumero → se descarta el RUNNING inicial también', async () => {
    const rowConNumeroDistinto = { ...BASE_ROW, cheque_numero: '00099999' };
    const { calls } = setupFetchMock(rowConNumeroDistinto);
    const repo = new SupabaseRestChequeRepository();

    const applied = await repo.applyBcraResult('CHK-TEST-1', { state: 'RUNNING', snapshot: SNAPSHOT });

    expect(applied).toBe(false);
    expect(calls.some((c) => c.method === 'PATCH')).toBe(false);
  });

  it('cheque inexistente → devuelve false sin lanzar', async () => {
    const fetchMock = vi.fn(async (url: string, options: any = {}) => {
      const method = options.method || 'GET';
      if (method === 'GET') return jsonResponse([]);
      throw new Error(`Unexpected fetch call: ${method} ${url}`);
    });
    global.fetch = fetchMock as any;
    const repo = new SupabaseRestChequeRepository();

    const applied = await repo.applyBcraResult('CHK-INEXISTENTE', { state: 'RUNNING', snapshot: SNAPSHOT });

    expect(applied).toBe(false);
  });
});

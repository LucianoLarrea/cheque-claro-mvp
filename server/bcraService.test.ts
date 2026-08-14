import { describe, expect, it, vi } from 'vitest';
import {
  BcraClient,
  buildBcraRiskLevel,
  normalizeBcraText,
  resolveBcraEntity,
  selectLatestDebtPeriod,
} from './services/bcraService';

function response(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function routeFetch(routes: Record<string, Response | (() => Response | Promise<Response>)>) {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    const route = Object.entries(routes).find(([prefix]) => url.includes(prefix))?.[1];
    if (!route) throw new Error(`Ruta no simulada: ${url}`);
    return typeof route === 'function' ? route() : route;
  });
}

const entities = [
  { codigoEntidad: 11, denominacion: 'Banco de la Nación Argentina' },
  { codigoEntidad: 22, denominacion: 'Banco Galicia y Buenos Aires S.A.U.' },
];

describe('BcraService', () => {
  it('normaliza acentos, mayúsculas y espacios para comparar titulares', () => {
    expect(normalizeBcraText('  Nación   Argentina ')).toBe('NACION ARGENTINA');
    expect(resolveBcraEntity('Banco de la Nacion', [{ codigoEntidad: 11, denominacion: 'Banco de la Nación Argentina' }]).status).toBe('resolved');
  });

  it('selecciona el período más reciente y la peor situación de sus entidades', () => {
    expect(selectLatestDebtPeriod([
      { periodo: '202501', entidades: [{ situacion: 1 }, { situacion: 2 }] },
      { periodo: '202503', entidades: [{ situacion: 2 }, { situacion: 5 }] },
      { periodo: '202502', entidades: [{ situacion: 6 }] },
    ])).toEqual({ periodo: '202503', situacion: 5 });
  });

  it('mapea 404 de deudas y rechazados como sin antecedentes y 404 de denuncia como no encontrado', async () => {
    const fetchImpl = routeFetch({
      '/Deudas/ChequesRechazados/20924550455': response(404, { status: 404 }),
      '/Deudas/20924550455': response(404, { status: 404 }),
      '/cheques/v1.0/entidades': response(200, { status: 200, results: entities }),
      '/denunciados/11/000123': response(404, { status: 404 }),
    });
    const result = await new BcraClient({ fetchImpl }).verifyCheque({ cuit: '20924550455', chequeNumero: '000123', banco: 'Banco de la Nación', librador: 'Persona' });
    expect(result.estados.deudas).toBe('sin_antecedentes');
    expect(result.estados.cheques_rechazados).toBe('sin_antecedentes');
    expect(result.cheque_denunciado).toMatchObject({ denunciado: false, estado: 'no_encontrado' });
    expect(result.nivel).toBe('sin_hallazgos');
  });

  it('extrae titular, período, peor situación, rechazados y una denuncia encontrada', async () => {
    const fetchImpl = routeFetch({
      '/Deudas/ChequesRechazados/20924550455': response(200, {
        status: 200,
        results: {
          causales: [{ causal: 'Falta de fondos', entidades: [{ entidad: 11, detalle: [{ nroCheque: '000777', monto: 250000 }, { nroCheque: '000778', monto: 300000 }] }] }],
        },
      }),
      '/Deudas/20924550455': response(200, {
        status: 200,
        results: {
          denominacion: 'ACME S.A.',
          periodos: [
            { periodo: '202501', entidades: [{ situacion: 1 }, { situacion: 2 }] },
            { periodo: '202502', entidades: [{ situacion: 2 }, { situacion: 4 }] },
          ],
        },
      }),
      '/cheques/v1.0/entidades': response(200, { status: 200, results: entities }),
      '/denunciados/11/000777': response(200, { status: 200, results: { denunciado: true, detalles: [{ sucursal: 3, numeroCuenta: 456, causal: 'Extravío' }] } }),
    });
    const result = await new BcraClient({ fetchImpl }).verifyCheque({ cuit: '20924550455', chequeNumero: '000777', banco: 'BANCO DE LA NACION', librador: ' acmé   s.a. ' });
    expect(result.titular_bcra).toBe('ACME S.A.');
    expect(result.titular_coincide).toBe(true);
    expect(result.periodo).toBe('202502');
    expect(result.situacion_crediticia).toBe(4);
    expect(result.cheques_rechazados.cantidad).toBe(2);
    expect(result.cheques_rechazados.detalle[0]).toMatchObject({ nroCheque: '000777', causal: 'Falta de fondos' });
    expect(result.cheque_denunciado).toMatchObject({ denunciado: true, estado: 'ok' });
    expect(result.entidad_bcra).toMatchObject({ codigoEntidad: 11, estado: 'ok' });
    expect(result.nivel).toBe('alerta');
  });

  it('no inventa código cuando el banco no existe o el matching es ambiguo', async () => {
    expect(resolveBcraEntity('Banco inexistente', entities)).toMatchObject({ status: 'entity_no_resuelta', entity: null });
    expect(resolveBcraEntity('Banco', [
      { codigoEntidad: 11, denominacion: 'Banco Norte' },
      { codigoEntidad: 22, denominacion: 'Banco Sur' },
    ])).toMatchObject({ status: 'entity_no_resuelta', entity: null });

    const fetchImpl = routeFetch({
      '/Deudas/ChequesRechazados/20924550455': response(404, {}),
      '/Deudas/20924550455': response(404, {}),
      '/cheques/v1.0/entidades': response(200, { results: [{ codigoEntidad: 11, denominacion: 'Banco Norte' }, { codigoEntidad: 22, denominacion: 'Banco Sur' }] }),
    });
    const result = await new BcraClient({ fetchImpl }).verifyCheque({ cuit: '20924550455', chequeNumero: '000123', banco: 'Banco', librador: null });
    expect(result.entidad_bcra).toEqual({ codigoEntidad: null, denominacion: null, estado: 'entidad_no_resuelta' });
    expect(result.cheque_denunciado.estado).toBe('entidad_no_resuelta');
    expect(fetchImpl.mock.calls.some(([input]) => String(input).includes('/denunciados/'))).toBe(false);
  });

  it('cachea entidades y no repite la consulta durante la vigencia del cache', async () => {
    const fetchImpl = routeFetch({
      '/Deudas/ChequesRechazados/20924550455': response(404, {}),
      '/Deudas/20924550455': response(404, {}),
      '/cheques/v1.0/entidades': response(200, { results: entities }),
      '/denunciados/11/000123': response(404, {}),
    });
    const client = new BcraClient({ fetchImpl, entityCacheTtlMs: 60_000 });
    await client.verifyCheque({ cuit: '20924550455', chequeNumero: '000123', banco: 'Banco de la Nación', librador: null });
    await client.verifyCheque({ cuit: '20924550455', chequeNumero: '000123', banco: 'Banco de la Nación', librador: null });
    expect(fetchImpl.mock.calls.filter(([input]) => String(input).includes('/cheques/v1.0/entidades'))).toHaveLength(1);
  });

  it('mantiene estados de error independientes cuando la API falla', async () => {
    const fetchImpl = vi.fn(async () => { throw new Error('BCRA fuera de servicio'); });
    const result = await new BcraClient({ fetchImpl, timeoutMs: 5 }).verifyCheque({ cuit: '20924550455', chequeNumero: '000123', banco: 'Banco', librador: null });
    expect(result.estados.deudas).toBe('error');
    expect(result.estados.cheques_rechazados).toBe('error');
    expect(result.estados.entidad).toBe('error');
    expect(result.estados.cheque_denunciado).toBe('error');
    expect(result.nivel).toBe('requiere_revision');
  });

  it('clasifica denuncia, rechazos y situación alta como alerta', () => {
    expect(buildBcraRiskLevel({
      titular_coincide: true,
      situacion_crediticia: 3,
      cheques_rechazados: { cantidad: 0, detalle: [], estado: 'ok' },
      cheque_denunciado: { denunciado: false, detalle: [], estado: 'no_encontrado' },
      entidad_bcra: { codigoEntidad: 11, denominacion: 'Banco', estado: 'ok' },
      estados: { deudas: 'ok', cheques_rechazados: 'ok', entidad: 'ok', cheque_denunciado: 'no_encontrado' },
    })).toBe('alerta');
  });
});

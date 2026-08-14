import { describe, expect, it } from 'vitest';
import {
  calculatePorcentaje,
  calculateQuote,
  getQuoteConfig,
  roundHalfUp,
} from './services/quoteService';

describe('quoteService', () => {
  it('lee la configuración desde el entorno y acepta los rangos válidos', () => {
    expect(getQuoteConfig({ TASA_MENSUAL: '14', DESCUENTO_MINIMO: '10' })).toEqual({ tasaMensual: 14, descuentoMinimo: 10 });
    expect(getQuoteConfig({})).toEqual({ tasaMensual: 14, descuentoMinimo: 10 });
  });

  it('rechaza valores de configuración fuera de rango', () => {
    expect(() => getQuoteConfig({ TASA_MENSUAL: '11', DESCUENTO_MINIMO: '10' })).toThrow('TASA_MENSUAL');
    expect(() => getQuoteConfig({ TASA_MENSUAL: '14', DESCUENTO_MINIMO: '11' })).toThrow('DESCUENTO_MINIMO');
  });

  it('calcula el tramo menor al plazo de transición', () => {
    const config = { tasaMensual: 14, descuentoMinimo: 10 };
    const result = calculatePorcentaje(10, config.tasaMensual, config.descuentoMinimo);
    expect(result.plazoTransicion).toBe(22);
    expect(result.porcentaje).toBeCloseTo(10.1212121212, 10);
  });

  it('calcula correctamente el plazo igual al de transición', () => {
    const result = calculatePorcentaje(22, 14, 10);
    expect(result.plazoTransicion).toBe(22);
    expect(result.porcentaje).toBeCloseTo(10.2666666667, 10);
  });

  it('calcula el tramo mayor al plazo de transición', () => {
    const result = calculatePorcentaje(34, 14, 10);
    expect(result.plazoTransicion).toBe(22);
    expect(result.porcentaje).toBeCloseTo(15.8666666667, 10);
  });

  it('responde a diferentes tasas y descuentos mínimos', () => {
    expect(calculatePorcentaje(30, 12, 8).porcentaje).toBe(12);
    expect(calculatePorcentaje(30, 15, 9).porcentaje).toBe(15);
    expect(calculatePorcentaje(1, 15, 8).plazoTransicion).toBe(16);
  });

  it('calcula una cotización lista con plazo basado en fechas UTC', () => {
    const result = calculateQuote({ amount: 2_500_000, dueDate: '2026-09-15', today: '2026-08-12', config: { tasaMensual: 14, descuentoMinimo: 10 } });
    expect(result.status).toBe('ready');
    if (result.status !== 'ready') return;
    expect(result.plazoDias).toBe(34);
    expect(result.plazoTransicion).toBe(22);
    expect(result.porcentaje).toBeCloseTo(15.8666666667, 10);
    expect(result.descuento).toBe(396666.67);
    expect(result.montoAPagar).toBe(2_103_333.33);
  });

  it('no cotiza cheques vencidos', () => {
    expect(calculateQuote({ amount: 1000, dueDate: '2026-08-11', today: '2026-08-12', config: { tasaMensual: 14, descuentoMinimo: 10 } })).toEqual({ status: 'expired', message: 'Cheque vencido' });
  });

  it('no cotiza si falta importe o vencimiento', () => {
    expect(calculateQuote({ amount: null, dueDate: '2026-09-15', today: '2026-08-12', config: { tasaMensual: 14, descuentoMinimo: 10 } })).toEqual({ status: 'incomplete', message: 'Falta el importe del cheque' });
    expect(calculateQuote({ amount: 1000, dueDate: null, today: '2026-08-12', config: { tasaMensual: 14, descuentoMinimo: 10 } })).toEqual({ status: 'incomplete', message: 'Falta la fecha de vencimiento' });
  });

  it('aplica redondeo HALF_UP a dos decimales', () => {
    expect(roundHalfUp(10.005, 2)).toBe(10.01);
    expect(roundHalfUp(10.004, 2)).toBe(10);
    expect(roundHalfUp(-10.005, 2)).toBe(-10.01);
  });
});

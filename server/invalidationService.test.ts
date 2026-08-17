import { describe, it, expect } from 'vitest';
import { determineInvalidation } from './services/invalidationService';

describe('Invalidation Matrix (determineInvalidation)', () => {
  const baseCheque = {
    cuit: '20-12345678-9',
    chequeNumero: '00012345',
    banco: 'Banco Galicia',
    librador: 'Empresa SA',
    importe: 100000.50,
    fechaPago: '2026-09-15',
    moneda: 'ARS',
    confidence: { cuit: 0.99 },
    ocrText: 'RAW TEXT'
  };

  it('debe no invalidar nada si no hay cambios', () => {
    const result = determineInvalidation(baseCheque, baseCheque);
    expect(result.changedFields).toHaveLength(0);
    expect(result.requiresBcraFetch).toBe(false);
    expect(result.requiresBcraReinterpretation).toBe(false);
    expect(result.requiresQuoteRecalc).toBe(false);
  });

  it('debe no invalidar nada si los campos nuevos están ausentes', () => {
    // Simulamos un PATCH con objeto vacío
    const result = determineInvalidation(baseCheque, {});
    expect(result.changedFields).toHaveLength(0);
  });

  it('debe no invalidar nada si cambia un campo no relevante (ej. confidence)', () => {
    const result = determineInvalidation(baseCheque, { confidence: { cuit: 0.5 } });
    expect(result.changedFields).toHaveLength(0);
  });

  it('debe requerir BCRA fetch y reinterpret si cambia el CUIT', () => {
    const result = determineInvalidation(baseCheque, { cuit: '27-87654321-4' });
    expect(result.changedFields).toContain('cuit');
    expect(result.requiresBcraFetch).toBe(true);
    expect(result.requiresBcraReinterpretation).toBe(true);
    expect(result.requiresQuoteRecalc).toBe(false);
  });

  it('debe requerir BCRA fetch y reinterpret si cambia el número de cheque', () => {
    const result = determineInvalidation(baseCheque, { chequeNumero: '00099999' });
    expect(result.changedFields).toContain('chequeNumero');
    expect(result.requiresBcraFetch).toBe(true);
    expect(result.requiresBcraReinterpretation).toBe(true);
    expect(result.requiresQuoteRecalc).toBe(false);
  });

  it('debe requerir BCRA fetch y reinterpret si cambia el banco', () => {
    const result = determineInvalidation(baseCheque, { banco: 'Banco Santander' });
    expect(result.changedFields).toContain('banco');
    expect(result.requiresBcraFetch).toBe(true);
    expect(result.requiresBcraReinterpretation).toBe(true);
    expect(result.requiresQuoteRecalc).toBe(false);
  });

  it('debe requerir SOLO BCRA reinterpret si cambia el librador', () => {
    const result = determineInvalidation(baseCheque, { librador: 'Otra Empresa SRL' });
    expect(result.changedFields).toContain('librador');
    expect(result.requiresBcraFetch).toBe(false);
    expect(result.requiresBcraReinterpretation).toBe(true);
    expect(result.requiresQuoteRecalc).toBe(false);
  });

  it('debe requerir recálculo de cotización si cambia el importe', () => {
    const result = determineInvalidation(baseCheque, { importe: 50000 });
    expect(result.changedFields).toContain('importe');
    expect(result.requiresBcraFetch).toBe(false);
    expect(result.requiresBcraReinterpretation).toBe(false);
    expect(result.requiresQuoteRecalc).toBe(true);
  });

  it('debe requerir recálculo de cotización si cambia la fechaPago', () => {
    const result = determineInvalidation(baseCheque, { fechaPago: '2026-10-01' });
    expect(result.changedFields).toContain('fechaPago');
    expect(result.requiresBcraFetch).toBe(false);
    expect(result.requiresBcraReinterpretation).toBe(false);
    expect(result.requiresQuoteRecalc).toBe(true);
  });

  it('debe requerir recálculo de cotización si cambia la moneda', () => {
    const result = determineInvalidation(baseCheque, { moneda: 'USD' });
    expect(result.changedFields).toContain('moneda');
    expect(result.requiresBcraFetch).toBe(false);
    expect(result.requiresBcraReinterpretation).toBe(false);
    expect(result.requiresQuoteRecalc).toBe(true);
  });

  // NORMALIZACION
  it('debe no invalidar el CUIT si solo cambia el formato (guiones)', () => {
    const result = determineInvalidation(baseCheque, { cuit: '20123456789' });
    expect(result.changedFields).not.toContain('cuit');
    expect(result.requiresBcraFetch).toBe(false);
  });

  it('debe no invalidar el importe si solo cambia de string a number pero equivale', () => {
    const result = determineInvalidation(baseCheque, { importe: '100.000,50' }); // 100000.50
    expect(result.changedFields).not.toContain('importe');
  });

  it('debe no invalidar fecha si solo cambia el formato a ISO', () => {
    const result = determineInvalidation(baseCheque, { fechaPago: '15/09/2026' }); // base es 2026-09-15
    expect(result.changedFields).not.toContain('fechaPago');
  });

  it('debe manejar correctamente strings con espacios y mayúsculas en banco/librador', () => {
    const result = determineInvalidation(baseCheque, { 
      banco: '   BANCO GALICIA  ',
      librador: 'EMPRESA SA'
    });
    expect(result.changedFields).not.toContain('banco');
    expect(result.changedFields).not.toContain('librador');
  });

  it('debe manejar nulls u opcionales ausentes', () => {
    // base no tiene status, nuevo tiene null -> no debería fallar ni reaccionar si no es de matriz
    const result = determineInvalidation({ ...baseCheque, cuit: null }, { cuit: '20-12345678-9' });
    expect(result.changedFields).toContain('cuit');
    
    const result2 = determineInvalidation(baseCheque, { cuit: null });
    expect(result2.changedFields).toContain('cuit');
  });

  // MULTIPLES CAMBIOS
  it('debe manejar combinación: CUIT e importe', () => {
    const result = determineInvalidation(baseCheque, { cuit: '27-87654321-4', importe: 500 });
    expect(result.changedFields).toContain('cuit');
    expect(result.changedFields).toContain('importe');
    expect(result.requiresBcraFetch).toBe(true);
    expect(result.requiresBcraReinterpretation).toBe(true);
    expect(result.requiresQuoteRecalc).toBe(true);
  });

  it('debe manejar combinación: librador e importe', () => {
    const result = determineInvalidation(baseCheque, { librador: 'Nuevo', importe: 500 });
    expect(result.requiresBcraFetch).toBe(false);
    expect(result.requiresBcraReinterpretation).toBe(true);
    expect(result.requiresQuoteRecalc).toBe(true);
  });

  it('debe manejar combinación: banco, fecha y moneda', () => {
    const result = determineInvalidation(baseCheque, { banco: 'Otro', fechaPago: '2027-01-01', moneda: 'EUR' });
    expect(result.requiresBcraFetch).toBe(true);
    expect(result.requiresBcraReinterpretation).toBe(true);
    expect(result.requiresQuoteRecalc).toBe(true);
  });

  it('debe manejar combinación: todos los campos', () => {
    const result = determineInvalidation(baseCheque, { 
      cuit: '27-87654321-4',
      chequeNumero: '999',
      banco: 'Macro',
      librador: 'Nueva SRL',
      importe: 500,
      fechaPago: '2026-12-12',
      moneda: 'USD'
    });
    expect(result.changedFields.length).toBe(7);
    expect(result.requiresBcraFetch).toBe(true);
    expect(result.requiresBcraReinterpretation).toBe(true);
    expect(result.requiresQuoteRecalc).toBe(true);
  });
});

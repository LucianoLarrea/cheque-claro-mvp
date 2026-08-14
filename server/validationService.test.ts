import { describe, expect, it } from 'vitest';
import {
  calculateFinalConfidence,
  normalizeFecha,
  normalizeImporte,
  normalizeNumeroCheque,
  validateCuit,
} from './services/validationService';

describe('validateCuit', () => {
  it('accepts mathematically valid synthetic CUITs', () => {
    expect(validateCuit('30-71122334-3').status).toBe('VALID');
    expect(validateCuit('20-12345678-6').status).toBe('VALID');
  });

  it('rejects invalid verifier, format and length', () => {
    expect(validateCuit('30-71122334-8').status).toBe('INVALID');
    expect(validateCuit('123').status).toBe('INVALID');
    expect(validateCuit('abc').status).toBe('INVALID');
  });
});

describe('normalizeImporte', () => {
  it('normalizes Argentine thousands and decimal separators', () => {
    expect(normalizeImporte('2.500.000').value).toBe(2500000);
    expect(normalizeImporte('2.500.000,50').value).toBe(2500000.5);
    expect(normalizeImporte('2500000').value).toBe(2500000);
    expect(normalizeImporte('$ 2.500.000,00').value).toBe(2500000);
  });
});

describe('normalizeFecha', () => {
  it('accepts Argentine date separators and returns ISO', () => {
    expect(normalizeFecha('15/09/2026').value).toBe('2026-09-15');
    expect(normalizeFecha('15-09-2026').value).toBe('2026-09-15');
    expect(normalizeFecha('15.09.2026').value).toBe('2026-09-15');
  });

  it('rejects impossible dates', () => {
    expect(normalizeFecha('31/02/2026').value).not.toBe('2026-02-31');
  });
});

describe('normalizeNumeroCheque', () => {
  it('preserves leading zeros', () => {
    expect(normalizeNumeroCheque('00123456').value).toBe('00123456');
    expect(normalizeNumeroCheque('123456').value).toBe('123456');
  });
});

describe('calculateFinalConfidence', () => {
  it('caps invalid values and lowers unknown or empty fields', () => {
    expect(calculateFinalConfidence(0.95, 'INVALID', true)).toBeLessThanOrEqual(0.4);
    expect(calculateFinalConfidence(0.95, 'UNKNOWN', true)).toBeLessThanOrEqual(0.7);
    expect(calculateFinalConfidence(0.95, 'VALID', false)).toBe(0.1);
  });
});

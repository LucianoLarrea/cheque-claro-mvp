import { describe, expect, it } from 'vitest';
import { formatCuit, normalizeCuit, validateCuit } from '@shared/cuitValidation';

describe('validación detallada de CUIT/CUIL', () => {
  it('acepta un CUIT matemáticamente válido y expone sus dígitos', () => {
    const result = validateCuit('20-12345678-6');

    expect(result).toMatchObject({
      status: 'VALID',
      format_valid: true,
      check_digit: 6,
      expected_check_digit: 6,
      valid: true,
      special_case: false,
    });
    expect(result.normalized).toBe('20123456786');
  });

  it('rechaza un CUIT con dígito verificador incorrecto y conserva ambos valores', () => {
    const result = validateCuit('20-12345678-5');

    expect(result).toMatchObject({
      status: 'INVALID',
      format_valid: true,
      check_digit: 5,
      expected_check_digit: 6,
      valid: false,
    });
    expect(result.message).toContain('dígito verificador');
  });

  it('normaliza guiones, espacios y puntos sin descartar caracteres inválidos silenciosamente', () => {
    expect(normalizeCuit(' 20-12345678-6 ')).toBe('20123456786');
    expect(normalizeCuit('20 12345678 6')).toBe('20123456786');
    expect(normalizeCuit('20.12345678.6')).toBe('20123456786');
    expect(validateCuit('20/12345678/6').format_valid).toBe(false);
    expect(validateCuit('abc20-12345678-6').format_valid).toBe(false);
  });

  it('acepta el formato sin separadores y lo vuelve a presentar con formato canónico', () => {
    expect(validateCuit('20123456786').valid).toBe(true);
    expect(formatCuit('20123456786')).toBe('20-12345678-6');
    expect(formatCuit('20.12345678.6')).toBe('20-12345678-6');
  });

  it('rechaza cantidades incorrectas de dígitos y entradas vacías', () => {
    expect(validateCuit('2012345678')).toMatchObject({ status: 'INVALID', format_valid: false, valid: false });
    expect(validateCuit('201234567866')).toMatchObject({ status: 'INVALID', format_valid: false, valid: false });
    expect(validateCuit(null)).toMatchObject({ status: 'UNKNOWN', format_valid: false, valid: false });
    expect(validateCuit('   ')).toMatchObject({ status: 'UNKNOWN', format_valid: false, valid: false });
  });

  it('acepta los casos especiales de asignación de prefijo 20/27/24/30/34', () => {
    const specialCases = [
      ['23-01000000-9', 9],
      ['23-01000008-4', 4],
      ['23-01000003-3', 3],
      ['33-01000003-9', 9],
      ['33-01000006-3', 3],
    ] as const;

    for (const [value, checkDigit] of specialCases) {
      expect(validateCuit(value), value).toMatchObject({
        status: 'VALID',
        format_valid: true,
        check_digit: checkDigit,
        expected_check_digit: checkDigit,
        valid: true,
        special_case: true,
      });
    }
  });

  it('no corrige automáticamente un prefijo fuente en caso especial', () => {
    const result = validateCuit('20-01000000-9');

    expect(result).toMatchObject({
      status: 'INVALID',
      format_valid: true,
      check_digit: 9,
      expected_check_digit: 9,
      valid: false,
      special_case: true,
    });
    expect(result.normalized).toBe('20010000009');
  });

  it('rechaza un dígito incorrecto en una asignación especial', () => {
    expect(validateCuit('23-01000000-4')).toMatchObject({
      status: 'INVALID',
      format_valid: true,
      check_digit: 4,
      expected_check_digit: 9,
      valid: false,
    });
  });

  it('confirma el caso real solicitado: 20-92455045-5 no pasa el módulo 11', () => {
    const result = validateCuit('20-92455045-5');

    expect(result).toMatchObject({
      status: 'INVALID',
      format_valid: true,
      check_digit: 5,
      expected_check_digit: 8,
      valid: false,
    });
  });
});

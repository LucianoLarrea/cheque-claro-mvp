import { formatCuit, validateCuit } from '@shared/cuitValidation';

export { formatCuit, validateCuit } from '@shared/cuitValidation';

export interface ValidationResult<T> {
  value: T;
  normalized: T;
  validationStatus: 'VALID' | 'INVALID' | 'UNKNOWN';
  confidence: number;
  message?: string;
  edited?: boolean;
}

/**
 * Normaliza el importe a number y valida formato argentino.
 */
export function normalizeImporte(importeInput: string | number | null | undefined): { value: number | null; confidence: number; message: string } {
  if (importeInput === null || importeInput === undefined) {
    return { value: null, confidence: 0.2, message: 'Importe no detectado' };
  }

  if (typeof importeInput === 'number') {
    return { value: importeInput, confidence: 0.99, message: 'Importe válido' };
  }

  let cleaned = importeInput.toString().trim();
  cleaned = cleaned.replace(/[$ARS\s]/g, '');

  // Detectar formato argentino ej: 2.500.000,50 o 2500000.50
  if (cleaned.includes('.') && cleaned.includes(',')) {
    // Si la coma está después del último punto, la coma es decimal
    const lastPoint = cleaned.lastIndexOf('.');
    const lastComma = cleaned.lastIndexOf(',');
    if (lastComma > lastPoint) {
      cleaned = cleaned.replace(/\./g, '').replace(',', '.');
    } else {
      cleaned = cleaned.replace(/,/g, '');
    }
  } else if (cleaned.includes('.')) {
    // Si tiene múltiples puntos, son miles
    const parts = cleaned.split('.');
    if (parts.length > 2) {
      cleaned = cleaned.replace(/\./g, '');
    } else if (parts.length === 2 && parts[1].length === 3) {
      // Ej 2.500 (miles) vs 2500.50 (decimal)
      cleaned = cleaned.replace(/\./g, '');
    }
  } else if (cleaned.includes(',')) {
    // Si solo tiene coma, verificar si es decimal (ej 2500,50)
    const parts = cleaned.split(',');
    if (parts.length === 2 && parts[1].length <= 2) {
      cleaned = cleaned.replace(',', '.');
    } else {
      cleaned = cleaned.replace(/,/g, '');
    }
  }

  const num = parseFloat(cleaned);
  if (isNaN(num) || num <= 0) {
    return { value: null, confidence: 0.3, message: 'Importe inválido' };
  }

  return { value: num, confidence: 0.95, message: 'Importe válido' };
}

/**
 * Normaliza y valida la fecha de pago a YYYY-MM-DD.
 */
export function normalizeFecha(fechaInput: string | null | undefined): { value: string | null; confidence: number; message: string } {
  if (!fechaInput) {
    return { value: null, confidence: 0.2, message: 'Fecha no detectada' };
  }

  let clean = fechaInput.trim();
  let day: number, month: number, year: number;

  // Formatos comunes: DD/MM/YYYY, DD-MM-YYYY, DD.MM.YYYY
  const match = clean.match(/^(\d{1,2})[\/\-\.](\d{1,2})[\/\-\.](\d{2,4})$/);
  if (match) {
    day = parseInt(match[1], 10);
    month = parseInt(match[2], 10);
    year = parseInt(match[3], 10);
    if (year < 100) year += 2000;
  } else {
    // Intentar YYYY-MM-DD
    const isoMatch = clean.match(/^(\d{4})[\/\-\.](\d{1,2})[\/\-\.](\d{1,2})$/);
    if (isoMatch) {
      year = parseInt(isoMatch[1], 10);
      month = parseInt(isoMatch[2], 10);
      day = parseInt(isoMatch[3], 10);
    } else {
      return { value: null, confidence: 0.3, message: 'Formato de fecha inválido' };
    }
  }

  if (month < 1 || month > 12 || day < 1 || year < 2020 || year > 2050) {
    return { value: null, confidence: 0.3, message: 'Fecha fuera de rango o inexistente' };
  }

  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  if (day > daysInMonth) {
    return { value: null, confidence: 0.3, message: 'Fecha fuera de rango o inexistente' };
  }

  const formattedMonth = month.toString().padStart(2, '0');
  const formattedDay = day.toString().padStart(2, '0');
  const isoDate = `${year}-${formattedMonth}-${formattedDay}`;

  return { value: isoDate, confidence: 0.96, message: 'Fecha válida' };
}

/**
 * Preserva ceros iniciales del número de cheque.
 */
export function normalizeNumeroCheque(numInput: string | number | null | undefined): { value: string | null; confidence: number; message: string } {
  if (numInput === null || numInput === undefined) {
    return { value: null, confidence: 0.2, message: 'Número de cheque no detectado' };
  }

  const str = numInput.toString().trim().replace(/[^\d]/g, '');
  if (str.length === 0) {
    return { value: null, confidence: 0.3, message: 'Número de cheque inválido' };
  }

  // Preservar ceros iniciales (ej: "00123456")
  return { value: str, confidence: 0.97, message: 'Número de cheque válido' };
}

export function calculateFinalConfidence(rawConfidence: number, validationStatus: 'VALID' | 'INVALID' | 'UNKNOWN', hasValue: boolean): number {
  if (!hasValue) return 0.1;
  let final = rawConfidence;
  if (validationStatus === 'INVALID') {
    final = Math.min(final, 0.4);
  } else if (validationStatus === 'UNKNOWN') {
    final = Math.min(final, 0.7);
  }
  return Number(Math.max(0.1, Math.min(1.0, final)).toFixed(2));
}

export function getConfidenceLevel(confidence: number): 'Alta confianza' | 'Revisar' | 'Baja confianza' {
  if (confidence >= 0.90) return 'Alta confianza';
  if (confidence >= 0.70) return 'Revisar';
  return 'Baja confianza';
}

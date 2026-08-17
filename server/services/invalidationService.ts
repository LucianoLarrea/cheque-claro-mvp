import { normalizeCuit } from '@shared/cuitValidation';
import { normalizeFecha, normalizeImporte, normalizeNumeroCheque } from './validationService';

export interface InvalidationResult {
  requiresBcraFetch: boolean;
  requiresBcraReinterpretation: boolean;
  requiresQuoteRecalc: boolean;
  changedFields: string[];
}

/**
 * Motor de decisión centralizado para determinar las consecuencias
 * de la edición de los campos de un cheque.
 */
export function determineInvalidation(oldCheque: Record<string, any>, newCheque: Record<string, any>): InvalidationResult {
  const result: InvalidationResult = {
    requiresBcraFetch: false,
    requiresBcraReinterpretation: false,
    requiresQuoteRecalc: false,
    changedFields: [],
  };

  if (!oldCheque || !newCheque) return result;

  if ('cuit' in newCheque) {
    const oldCuit = normalizeCuit(oldCheque.cuit) || null;
    const newCuit = normalizeCuit(newCheque.cuit) || null;
    if (oldCuit !== newCuit) {
      result.changedFields.push('cuit');
      result.requiresBcraFetch = true;
      result.requiresBcraReinterpretation = true;
    }
  }

  if ('chequeNumero' in newCheque) {
    const oldNum = normalizeNumeroCheque(oldCheque.chequeNumero)?.value || null;
    const newNum = normalizeNumeroCheque(newCheque.chequeNumero)?.value || null;
    if (oldNum !== newNum) {
      result.changedFields.push('chequeNumero');
      result.requiresBcraFetch = true;
      result.requiresBcraReinterpretation = true;
    }
  }

  if ('banco' in newCheque) {
    const oldBanco = oldCheque.banco?.toString().trim().toLowerCase() || null;
    const newBanco = newCheque.banco?.toString().trim().toLowerCase() || null;
    if (oldBanco !== newBanco) {
      result.changedFields.push('banco');
      result.requiresBcraFetch = true;
      result.requiresBcraReinterpretation = true;
    }
  }

  if ('librador' in newCheque) {
    const oldLibrador = oldCheque.librador?.toString().trim().toLowerCase() || null;
    const newLibrador = newCheque.librador?.toString().trim().toLowerCase() || null;
    if (oldLibrador !== newLibrador) {
      result.changedFields.push('librador');
      result.requiresBcraReinterpretation = true;
    }
  }

  if ('importe' in newCheque) {
    const oldImporte = normalizeImporte(oldCheque.importe)?.value || null;
    const newImporte = normalizeImporte(newCheque.importe)?.value || null;
    if (oldImporte !== newImporte) {
      result.changedFields.push('importe');
      result.requiresQuoteRecalc = true;
    }
  }

  if ('fechaPago' in newCheque) {
    const oldFecha = normalizeFecha(oldCheque.fechaPago)?.value || null;
    const newFecha = normalizeFecha(newCheque.fechaPago)?.value || null;
    if (oldFecha !== newFecha) {
      result.changedFields.push('fechaPago');
      result.requiresQuoteRecalc = true;
    }
  }

  if ('moneda' in newCheque) {
    const oldMoneda = oldCheque.moneda?.toString().trim().toUpperCase() || null;
    const newMoneda = newCheque.moneda?.toString().trim().toUpperCase() || null;
    if (oldMoneda !== newMoneda) {
      result.changedFields.push('moneda');
      result.requiresQuoteRecalc = true;
    }
  }

  return result;
}

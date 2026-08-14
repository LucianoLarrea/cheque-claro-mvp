import type { ExtractedChequeData } from './geminiService';
import { normalizeFecha, normalizeImporte, normalizeNumeroCheque } from './validationService';

export type EvaluationField = 'cuit' | 'cheque_numero' | 'importe' | 'fecha_pago';

export interface EvaluationGroundTruth {
  cuit: string | null;
  cheque_numero: string | null;
  importe: string | number | null;
  fecha_pago: string | null;
}

export interface EvaluationFieldResult {
  correct: boolean;
  geminiValue: string | number | null;
  realValue: string | number | null;
  evidence: string | null;
}

export interface EvaluationStats {
  processedCheques: number;
  precision: Record<EvaluationField, number>;
  correctByField: Record<EvaluationField, number>;
  corrections: number;
  humanInterventions: number;
  humanInterventionRate: number;
}

export interface EvaluationResult {
  id: string;
  evaluatedAt: number;
  fields: Record<EvaluationField, EvaluationFieldResult>;
  corrections: number;
  humanIntervention: boolean;
  stats: EvaluationStats;
}

interface EvaluationRecord extends Omit<EvaluationResult, 'stats'> {}

const fields: EvaluationField[] = ['cuit', 'cheque_numero', 'importe', 'fecha_pago'];

function normalizeCuit(value: string | null | undefined): string | null {
  if (!value) return null;
  const digits = value.replace(/\D/g, '');
  return digits || null;
}

function normalizeFieldValue(field: EvaluationField, value: string | number | null | undefined): string | number | null {
  if (field === 'cuit') return normalizeCuit(typeof value === 'string' ? value : value == null ? null : String(value));
  if (field === 'cheque_numero') return normalizeNumeroCheque(value).value;
  if (field === 'importe') return normalizeImporte(value).value;
  return normalizeFecha(typeof value === 'string' ? value : value == null ? null : String(value)).value;
}

function valuesEqual(field: EvaluationField, left: string | number | null, right: string | number | null): boolean {
  if (left === null || right === null) return left === right;
  if (field === 'importe') return Math.abs(Number(left) - Number(right)) < 0.005;
  return String(left) === String(right);
}

function initialStats(): EvaluationStats {
  return {
    processedCheques: 0,
    precision: { cuit: 0, cheque_numero: 0, importe: 0, fecha_pago: 0 },
    correctByField: { cuit: 0, cheque_numero: 0, importe: 0, fecha_pago: 0 },
    corrections: 0,
    humanInterventions: 0,
    humanInterventionRate: 0,
  };
}

export class InMemoryEvaluationService {
  private readonly records: EvaluationRecord[] = [];
  private sequence = 0;

  evaluate(data: ExtractedChequeData, groundTruth: EvaluationGroundTruth): EvaluationResult {
    const id = `EVAL-${String(++this.sequence).padStart(6, '0')}`;
    const sourceValues: Record<EvaluationField, string | number | null> = {
      cuit: data.cuit,
      cheque_numero: data.cheque_numero,
      importe: data.importe,
      fecha_pago: data.fecha_pago,
    };
    const truthValues: Record<EvaluationField, string | number | null> = {
      cuit: groundTruth.cuit,
      cheque_numero: groundTruth.cheque_numero,
      importe: groundTruth.importe,
      fecha_pago: groundTruth.fecha_pago,
    };
    const evidence: Record<EvaluationField, string | null> = {
      cuit: data.cuit_evidence ?? null,
      cheque_numero: data.cheque_numero_evidence ?? null,
      importe: data.importe_evidence ?? null,
      fecha_pago: data.fecha_evidence ?? null,
    };

    const evaluatedFields = Object.fromEntries(fields.map((field) => {
      const geminiValue = normalizeFieldValue(field, sourceValues[field]);
      const realValue = normalizeFieldValue(field, truthValues[field]);
      return [field, { correct: valuesEqual(field, geminiValue, realValue), geminiValue, realValue, evidence: evidence[field] }];
    })) as Record<EvaluationField, EvaluationFieldResult>;
    const corrections = fields.filter((field) => !evaluatedFields[field].correct).length;
    const record: EvaluationRecord = {
      id,
      evaluatedAt: Date.now(),
      fields: evaluatedFields,
      corrections,
      humanIntervention: corrections > 0,
    };
    this.records.push(record);
    return { ...record, stats: this.getStats() };
  }

  getStats(): EvaluationStats {
    const stats = initialStats();
    stats.processedCheques = this.records.length;
    for (const record of this.records) {
      stats.corrections += record.corrections;
      if (record.humanIntervention) stats.humanInterventions += 1;
      for (const field of fields) if (record.fields[field].correct) stats.correctByField[field] += 1;
    }
    if (stats.processedCheques > 0) {
      for (const field of fields) stats.precision[field] = Number((stats.correctByField[field] / stats.processedCheques).toFixed(4));
      stats.humanInterventionRate = Number((stats.humanInterventions / stats.processedCheques).toFixed(4));
    }
    return stats;
  }

  list(): EvaluationRecord[] {
    return [...this.records];
  }

  reset(): void {
    this.records.length = 0;
    this.sequence = 0;
  }
}

export const evaluationService = new InMemoryEvaluationService();
export { normalizeFieldValue };

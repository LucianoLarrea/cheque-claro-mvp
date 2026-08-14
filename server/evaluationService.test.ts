import { describe, expect, it } from 'vitest';
import { InMemoryEvaluationService } from './services/evaluationService';
import type { ExtractedChequeData } from './services/geminiService';

const baseData: ExtractedChequeData = {
  cuit: '20-92455045-5',
  cuit_evidence: '20-92455045-5',
  cheque_numero: '00012345',
  cheque_numero_evidence: '00012345',
  banco: 'Banco de La Pampa',
  importe: 2500000,
  importe_evidence: '$ 2.500.000',
  moneda: 'ARS',
  fecha_pago: '2026-09-15',
  fecha_evidence: '15/09/2026',
  librador: 'Empresa de Prueba',
  confidence: { cuit: 0.95, cheque_numero: 0.95, banco: 0.9, importe: 0.95, fecha_pago: 0.95, librador: 0.9 },
};

describe('evaluationService', () => {
  it('marca los cuatro campos como correctos y conserva evidencia', () => {
    const service = new InMemoryEvaluationService();
    const result = service.evaluate(baseData, { cuit: '20924550455', cheque_numero: '00012345', importe: '2.500.000,00', fecha_pago: '15/09/2026' });

    expect(Object.values(result.fields).every((field) => field.correct)).toBe(true);
    expect(result.fields.importe.evidence).toBe('$ 2.500.000');
    expect(result.stats).toMatchObject({ processedCheques: 1, corrections: 0, humanInterventionRate: 0, precision: { cuit: 1, cheque_numero: 1, importe: 1, fecha_pago: 1 } });
  });

  it('cuenta correcciones e intervención humana cuando hay diferencias', () => {
    const service = new InMemoryEvaluationService();
    const result = service.evaluate(baseData, { cuit: '20924550455', cheque_numero: '00099999', importe: '2.400.000', fecha_pago: '16/09/2026' });

    expect(result.fields.cuit.correct).toBe(true);
    expect(result.fields.cheque_numero.correct).toBe(false);
    expect(result.fields.importe.correct).toBe(false);
    expect(result.fields.fecha_pago.correct).toBe(false);
    expect(result.corrections).toBe(3);
    expect(result.stats).toMatchObject({ processedCheques: 1, corrections: 3, humanInterventions: 1, humanInterventionRate: 1, precision: { cuit: 1, cheque_numero: 0, importe: 0, fecha_pago: 0 } });
  });
});

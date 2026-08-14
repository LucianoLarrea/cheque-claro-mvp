import { describe, expect, it } from 'vitest';
import { InMemoryChequeRepository } from './services/chequeRepository';
import { preprocessImage } from './services/imageService';
import { ocrService } from './services/ocrService';
import { ExtractionService } from './services/extractionService';

const chequePayload = {
  imageUrl: '',
  cuit: '30-71122334-3',
  cuitValidation: 'VALID' as const,
  chequeNumero: '000001',
  banco: 'Banco de prueba',
  importe: 1000,
  moneda: 'ARS',
  fechaPago: '2026-09-15',
  librador: 'Empresa de prueba',
  ocrText: '',
  confidence: { cuit: 0.98, cheque_numero: 0.98, banco: 0.9, importe: 0.98, fecha_pago: 0.95, librador: 0.9 },
  extractionMode: 'mock',
  editedFields: [],
};

describe('InMemoryChequeRepository', () => {
  it('implements persistence in memory and generates strict incremental IDs', async () => {
    const repository = new InMemoryChequeRepository();
    const first = await repository.saveCheque(chequePayload);
    const second = await repository.saveCheque({ ...chequePayload, chequeNumero: '000002' });

    expect(first.id).toBe('CHK-000001');
    expect(second.id).toBe('CHK-000002');
    expect(await repository.getCheque(first.id)).toEqual(first);
    expect((await repository.listCheques())).toHaveLength(2);
  });
});

describe('preprocessImage', () => {
  it('rejects unsupported formats before invoking Sharp', async () => {
    await expect(preprocessImage(Buffer.from('not-an-image'), 'cheque.gif', '/tmp/cheque-claro-test', 'image/gif'))
      .rejects.toThrow('Formato de imagen no compatible');
  });
});

describe('OCRService', () => {
  it('returns a descriptive error for a missing image', async () => {
    await expect(ocrService.extractText('/tmp/cheque-claro-missing-image.jpg'))
      .rejects.toThrow('Error en Tesseract OCR');
  });
});

describe('ExtractionService', () => {
  it('runs MOCK without Sharp, OCR, Gemini or network calls', async () => {
    const service = new ExtractionService();
    const result = await service.extract(Buffer.from('ignored'), 'cheque.jpg', 'mock', 'image/jpeg');
    expect(result.mode).toBe('mock');
    expect(result.data.cheque_numero).toBe('00458922');
    expect(result.data.validation.cuit.status).toBe('VALID');
    expect(result.data.cuit_validation).toMatchObject({
      format_valid: true,
      check_digit: 3,
      expected_check_digit: 3,
      valid: true,
    });
  });
});

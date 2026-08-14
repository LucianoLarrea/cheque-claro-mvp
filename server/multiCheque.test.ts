import { afterEach, describe, expect, it, vi } from 'vitest';
import sharp from 'sharp';
import { ExtractionService, normalizeBoundingBox } from './services/extractionService';
import { geminiService, type VisionChequeData } from './services/geminiService';

function makeVisionCheque(id: number, x: number, y: number, partial = false): VisionChequeData {
  const number = String(id).padStart(8, '0');
  return {
    id,
    bbox: { x, y, width: 0.28, height: 0.34 },
    partially_visible: partial,
    cuit: `20-0000000${id}-${id}`,
    cuit_evidence: `20-0000000${id}-${id}`,
    cheque_numero: number,
    cheque_numero_evidence: number,
    banco: `Banco ${id}`,
    importe: id * 100000,
    importe_evidence: `$ ${id * 100000}`,
    moneda: 'ARS',
    fecha_pago: `2026-09-${String(10 + id).padStart(2, '0')}`,
    fecha_evidence: `${10 + id}/09/2026`,
    librador: `Librador ${id}`,
    confidence: { cuit: 0.98, cheque_numero: 0.97, banco: 0.95, importe: 0.96, fecha_pago: 0.94, librador: 0.93 },
  };
}

async function createFixture(count: number) {
  return sharp({ create: { width: 1600, height: count === 1 ? 900 : 1600, channels: 3, background: { r: 242, g: 240, b: 232 } } }).png().toBuffer();
}

describe('multi-cheque Gemini Vision flow', () => {
  afterEach(() => vi.restoreAllMocks());

  it.each([1, 2, 3])('returns exactly %i independent cheque objects for a test image', async (count) => {
    const detected = Array.from({ length: count }, (_, index) => makeVisionCheque(index + 1, 0.08 + index * 0.3, count === 1 ? 0.25 : 0.12 + (index % 2) * 0.45));
    vi.spyOn(geminiService, 'extractFromVision').mockResolvedValue({ data: detected, durationMs: 12 });

    const result = await new ExtractionService().extract(await createFixture(count), `multi-${count}.png`, 'gemini_vision', 'image/png');

    expect(result.cheques).toHaveLength(count);
    expect(result.cheques.map((cheque) => cheque.id)).toEqual(Array.from({ length: count }, (_, index) => index + 1));
    expect(new Set(result.cheques.map((cheque) => cheque.cheque_numero)).size).toBe(count);
    result.cheques.forEach((cheque, index) => {
      expect(cheque.cheque_numero).toBe(String(index + 1).padStart(8, '0'));
      expect(cheque.banco).toBe(`Banco ${index + 1}`);
      expect(cheque.bbox.width).toBeGreaterThan(0);
      expect(cheque.bbox.height).toBeGreaterThan(0);
    });
  });

  it('keeps every normalized bbox inside the image bounds', () => {
    expect(normalizeBoundingBox({ x: 0.93, y: 0.9, width: 0.25, height: 0.2 })).toEqual({
      bbox: { x: 0.75, y: 0.8, width: 0.25, height: 0.2 },
      corrected: true,
    });
    expect(normalizeBoundingBox({ x: -0.2, y: 1.4, width: 2, height: Number.NaN })).toEqual({
      bbox: { x: 0, y: 1, width: 1, height: 0 },
      corrected: true,
    });
  });

  it('marks a geometrically corrected cheque as partially visible and lowers confidence', async () => {
    const detected = [makeVisionCheque(1, 0.93, 0.9, false), makeVisionCheque(2, 0.58, 0.1, false)];
    detected[0].bbox = { x: 0.93, y: 0.9, width: 0.25, height: 0.2 };
    vi.spyOn(geminiService, 'extractFromVision').mockResolvedValue({ data: detected, durationMs: 12 });

    const result = await new ExtractionService().extract(await createFixture(2), 'corrected-two.png', 'gemini_vision', 'image/png');

    expect(result.cheques[0]?.bbox).toEqual({ x: 0.75, y: 0.8, width: 0.25, height: 0.2 });
    expect(result.cheques[0]?.partially_visible).toBe(true);
    expect(result.cheques[0]?.finalConfidence.cuit).toBeLessThan(result.cheques[1]?.finalConfidence.cuit ?? 1);
    expect(result.cheques[1]?.cheque_numero).toBe('00000002');
  });

  it('lowers confidence for a partially visible cheque without changing another cheque', async () => {
    const detected = [makeVisionCheque(1, 0.05, 0.1, true), makeVisionCheque(2, 0.58, 0.1, false)];
    vi.spyOn(geminiService, 'extractFromVision').mockResolvedValue({ data: detected, durationMs: 12 });

    const result = await new ExtractionService().extract(await createFixture(2), 'partial-two.png', 'gemini_vision', 'image/png');

    expect(result.cheques[0]?.partially_visible).toBe(true);
    expect(result.cheques[0]?.finalConfidence.cuit).toBeLessThan(0.98);
    expect(result.cheques[1]?.partially_visible).toBe(false);
    expect(result.cheques[1]?.cuit).toBe('20-00000002-2');
    expect(result.cheques[1]?.cheque_numero).toBe('00000002');
  });
});

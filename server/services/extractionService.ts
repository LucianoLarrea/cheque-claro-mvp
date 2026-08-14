import fs from 'fs';
import os from 'os';
import path from 'path';
import { geminiService, ChequeBoundingBox, ExtractedChequeData, VisionChequeData } from './geminiService';
import { ocrService } from './ocrService';
import { preprocessImage } from './imageService';
import {
  calculateFinalConfidence,
  formatCuit,
  normalizeFecha,
  normalizeImporte,
  normalizeNumeroCheque,
  validateCuit,
} from './validationService';
import { bcraClient, buildSkippedBcraVerification, BcraVerification } from './bcraService';

export type ExtractionMode = 'mock' | 'ocr_gemini' | 'gemini_vision';

export interface ValidatedChequeData extends ExtractedChequeData {
  validation: {
    cuit: ReturnType<typeof validateCuit>;
    importe: ReturnType<typeof normalizeImporte>;
    fecha_pago: ReturnType<typeof normalizeFecha>;
    cheque_numero: ReturnType<typeof normalizeNumeroCheque>;
  };
  cuit_validation: ReturnType<typeof validateCuit>;
  bcra: BcraVerification;
  finalConfidence: ExtractedChequeData['confidence'];
}

export interface ValidatedVisionChequeData extends ValidatedChequeData {
  id: number;
  bbox: ChequeBoundingBox;
  partially_visible: boolean;
}

export interface ExtractionResult {
  mode: ExtractionMode;
  data: ValidatedChequeData;
  cheques: ValidatedVisionChequeData[];
  ocrText: string;
  originalImageUrl?: string;
  debug?: {
    ocrDurationMs: number;
    geminiDurationMs: number;
    confidenceOriginal: ExtractedChequeData['confidence'];
    confidenceFinal: ExtractedChequeData['confidence'];
    validation: ValidatedChequeData['validation'];
  };
  comparison?: {
    ocrGemini: ValidatedChequeData;
    geminiVision: ValidatedChequeData;
  };
}

function modeFromEnv(): ExtractionMode {
  const value = (process.env.EXTRACTION_MODE || 'gemini_vision').toLowerCase();
  if (value === 'ocr_gemini' || value === 'gemini_vision' || value === 'mock') return value;
  return 'gemini_vision';
}

function clampConfidence(value: unknown, fallback = 0.2): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : fallback;
}

function validateAndNormalize(raw: ExtractedChequeData): ValidatedChequeData {
  const cuitValidation = validateCuit(raw.cuit);
  const importeValidation = normalizeImporte(raw.importe);
  const fechaValidation = normalizeFecha(raw.fecha_pago);
  const numeroValidation = normalizeNumeroCheque(raw.cheque_numero);

  const confidence = {
    cuit: clampConfidence(raw.confidence?.cuit),
    cheque_numero: clampConfidence(raw.confidence?.cheque_numero),
    banco: clampConfidence(raw.confidence?.banco),
    importe: clampConfidence(raw.confidence?.importe),
    fecha_pago: clampConfidence(raw.confidence?.fecha_pago),
    librador: clampConfidence(raw.confidence?.librador),
  };

  const finalConfidence = {
    cuit: calculateFinalConfidence(confidence.cuit, cuitValidation.status, Boolean(cuitValidation.status !== 'UNKNOWN' && raw.cuit)),
    cheque_numero: calculateFinalConfidence(confidence.cheque_numero, numeroValidation.value ? 'VALID' : 'UNKNOWN', Boolean(numeroValidation.value)),
    banco: calculateFinalConfidence(confidence.banco, raw.banco ? 'VALID' : 'UNKNOWN', Boolean(raw.banco)),
    importe: calculateFinalConfidence(confidence.importe, importeValidation.value !== null ? 'VALID' : 'UNKNOWN', importeValidation.value !== null),
    fecha_pago: calculateFinalConfidence(confidence.fecha_pago, fechaValidation.value ? 'VALID' : 'UNKNOWN', Boolean(fechaValidation.value)),
    librador: calculateFinalConfidence(confidence.librador, raw.librador ? 'VALID' : 'UNKNOWN', Boolean(raw.librador)),
  };

  return {
    ...raw,
    cuit: formatCuit(raw.cuit),
    cheque_numero: numeroValidation.value,
    importe: importeValidation.value,
    fecha_pago: fechaValidation.value,
    moneda: raw.moneda || 'ARS',
    confidence,
    validation: {
      cuit: cuitValidation,
      importe: importeValidation,
      fecha_pago: fechaValidation,
      cheque_numero: numeroValidation,
    },
    cuit_validation: cuitValidation,
    bcra: buildSkippedBcraVerification(),
    finalConfidence,
  };
}

export function normalizeBoundingBox(raw: Partial<ChequeBoundingBox> | null | undefined): { bbox: ChequeBoundingBox; corrected: boolean } {
  const normalizeCoordinate = (value: unknown) => typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0;
  const rawX = normalizeCoordinate(raw?.x);
  const rawY = normalizeCoordinate(raw?.y);
  const width = normalizeCoordinate(raw?.width);
  const height = normalizeCoordinate(raw?.height);
  let x = rawX;
  let y = rawY;
  let corrected = x !== raw?.x || y !== raw?.y || width !== raw?.width || height !== raw?.height;

  // Preserve the model's estimated size where possible, but fit the rectangle inside the image.
  if (x + width > 1) {
    x = Math.max(0, 1 - width);
    corrected = true;
  }
  if (y + height > 1) {
    y = Math.max(0, 1 - height);
    corrected = true;
  }

  return { bbox: { x, y, width, height }, corrected };
}

async function verifyWithBcra<T extends ValidatedChequeData>(data: T): Promise<T> {
  const cuitsList = Array.isArray(data.cuits) && data.cuits.length > 0
    ? data.cuits
    : [{ cuit: data.cuit, role: 'primary' as const }];

  const processedCuits = await Promise.all(
    cuitsList.map(async (cItem) => {
      const cuitValidation = validateCuit(cItem.cuit);
      let bcra = buildSkippedBcraVerification();
      if (cuitValidation.valid && cuitValidation.normalized && data.cheque_numero) {
        try {
          bcra = await bcraClient.verifyCheque({
            cuit: cuitValidation.normalized,
            chequeNumero: data.cheque_numero,
            banco: data.banco,
            librador: data.librador,
          });
        } catch (e) {
          console.error(`Error en BCRA para CUIT ${cItem.cuit}:`, e);
        }
      }
      return {
        ...cItem,
        cuit: formatCuit(cItem.cuit),
        validation: cuitValidation,
        bcra,
      };
    })
  );

  const primaryEntry = processedCuits.find((c) => c.role === 'primary') || processedCuits[0];
  const primaryBcra = primaryEntry?.bcra || buildSkippedBcraVerification();
  const primaryValidation = primaryEntry?.validation || data.cuit_validation;

  return {
    ...data,
    cuit: primaryEntry ? primaryEntry.cuit : data.cuit,
    cuit_validation: primaryValidation,
    bcra: primaryBcra,
    cuits: processedCuits,
  } as T;
}

function validateVisionAndNormalize(raw: ExtractedChequeData, fallbackId: number): ValidatedVisionChequeData {
  const validated = validateAndNormalize(raw);
  const rawBbox = (raw as VisionChequeData).bbox;
  const hasBoundingBox = Boolean(rawBbox && typeof rawBbox === 'object');
  const normalizedBox = hasBoundingBox ? normalizeBoundingBox(rawBbox) : { bbox: { x: 0, y: 0, width: 0, height: 0 }, corrected: false };
  const partiallyVisible = Boolean((raw as VisionChequeData).partially_visible) || normalizedBox.corrected;
  const confidenceScale = partiallyVisible ? 0.65 : 1;
  const confidence = Object.fromEntries(Object.entries(validated.confidence).map(([key, value]) => [key, value * confidenceScale])) as ValidatedChequeData['confidence'];
  const finalConfidence = Object.fromEntries(Object.entries(validated.finalConfidence).map(([key, value]) => [key, value * confidenceScale])) as ValidatedChequeData['finalConfidence'];
  return {
    ...validated,
    confidence,
    finalConfidence,
    // El backend asigna IDs secuenciales por posición; no confía en IDs generados por el modelo.
    id: fallbackId,
    bbox: normalizedBox.bbox,
    partially_visible: partiallyVisible,
  };
}

export class ExtractionService {
  async extract(inputBuffer: Buffer, filename: string, requestedMode?: ExtractionMode, mimeType?: string): Promise<ExtractionResult> {
    const mode = requestedMode || modeFromEnv();
    const uploadDir = path.join(os.tmpdir(), 'cheque-claro');
    const comparisonEnabled = String(process.env.COMPARISON_MODE).toLowerCase() === 'true';
    const processed = mode === 'mock' && !comparisonEnabled
      ? null
      : await preprocessImage(inputBuffer, filename, uploadDir, mimeType);

    let data: ValidatedChequeData;
    let cheques: ValidatedVisionChequeData[] = [];
    let ocrText = '';
    let ocrDurationMs = 0;
    let geminiDurationMs = 0;

    if (mode === 'mock') {
      data = validateAndNormalize(geminiService.getMockData());
      cheques = [validateVisionAndNormalize(data, 1)];
      ocrText = 'MODO MOCK: no se ejecutó Tesseract. Datos sintéticos para pruebas de UI.';
    } else if (mode === 'ocr_gemini') {
      const ocr = await ocrService.extractText(processed!.processedPath);
      if (ocr.error) throw new Error('No pudimos leer correctamente la imagen. Tesseract no está instalado o la imagen no pudo procesarse.');
      ocrText = ocr.text;
      ocrDurationMs = ocr.durationMs;
      if (!ocrText.trim()) throw new Error('No se detectó suficiente información. Intentá con una foto más clara.');
      const gemini = await geminiService.extractFromOcrText(ocrText);
      const normalized = validateVisionAndNormalize(gemini.data, 1);
      cheques = [await verifyWithBcra(normalized)];
      data = cheques[0];
      geminiDurationMs = gemini.durationMs;
    } else {
      const gemini = await geminiService.extractFromVision(processed!.processedPath);
      const normalizedCheques = gemini.data.map((item, index) => validateVisionAndNormalize(item, index + 1));
      if (normalizedCheques.length === 0) throw new Error('Gemini no detectó ningún cheque independiente en la imagen.');
      cheques = await Promise.all(normalizedCheques.map((item) => verifyWithBcra(item)));
      data = cheques[0];
      geminiDurationMs = gemini.durationMs;
    }

    let comparison: ExtractionResult['comparison'];
    if (comparisonEnabled) {
      const ocr = await ocrService.extractText(processed!.processedPath);
      if (ocr.error || !ocr.text.trim()) {
        throw new Error(ocr.error || 'No se detectó texto con Tesseract en la comparación A/B.');
      }
      const ocrData = validateAndNormalize((await geminiService.extractFromOcrText(ocr.text)).data);
      const visionResult = await geminiService.extractFromVision(processed!.processedPath);
      const visionData = validateAndNormalize(visionResult.data[0]);
      comparison = { ocrGemini: ocrData, geminiVision: visionData };
    }

    const debug = String(process.env.DEBUG_EXTRACTION).toLowerCase() === 'true'
      ? {
          ocrDurationMs,
          geminiDurationMs,
          confidenceOriginal: data.confidence,
          confidenceFinal: data.finalConfidence,
          validation: data.validation,
        }
      : undefined;

    // Limpieza temporal: se mantienen sólo durante la extracción.
    if (processed) {
      await Promise.allSettled([
        fs.promises.unlink(processed.originalPath),
        fs.promises.unlink(processed.processedPath),
      ]);
    }

    return {
      mode,
      data,
      cheques,
      ocrText,
      debug,
      comparison,
    };
  }
}

export const extractionService = new ExtractionService();
export { modeFromEnv, validateAndNormalize };

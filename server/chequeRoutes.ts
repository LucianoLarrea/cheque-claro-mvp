import type { Express, Request, Response } from 'express';
import { extractionService, verifyWithBcra, ValidatedChequeData } from './services/extractionService';
import { chequeRepository } from './services/chequeRepository';
import type { BcraSnapshot } from './services/chequeRepository';
import { PersistenceError } from './dbSupabaseRest';
import { normalizeFecha, normalizeImporte, normalizeNumeroCheque, validateCuit, formatCuit } from './services/validationService';
import { evaluationService, EvaluationGroundTruth } from './services/evaluationService';
import { calculateQuote, getQuoteConfig } from './services/quoteService';

const MAX_BYTES = 10 * 1024 * 1024;
const ALLOWED_MIME = new Set(['image/jpeg', 'image/png', 'image/webp']);
const ALLOWED_EXT = new Set(['.jpg', '.jpeg', '.png', '.webp']);

function isImageValid(filename: string, mimeType: string, bytes: number) {
  const ext = filename.slice(filename.lastIndexOf('.')).toLowerCase();
  return ALLOWED_MIME.has(mimeType) && ALLOWED_EXT.has(ext) && bytes > 0 && bytes <= MAX_BYTES;
}

async function readMultipartImage(req: Request): Promise<{ buffer: Buffer; filename: string; mimeType: string }> {
  const contentType = req.headers['content-type'] || '';
  const boundaryMatch = contentType.match(/boundary=([^;]+)/i);
  if (!boundaryMatch) throw new Error('La solicitud multipart no tiene un boundary válido.');
  const boundary = `--${boundaryMatch[1].replace(/^"|"$/g, '')}`;
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  const body = Buffer.concat(chunks);
  if (body.length > MAX_BYTES + 1024 * 1024) throw new Error('La imagen excede el tamaño máximo permitido de 10 MB.');

  const marker = Buffer.from(boundary);
  let cursor = 0;
  while (cursor < body.length) {
    const start = body.indexOf(marker, cursor);
    if (start < 0) break;
    const headerStart = start + marker.length + 2;
    const nextBoundary = body.indexOf(marker, headerStart);
    if (nextBoundary < 0) break;
    const part = body.subarray(headerStart, nextBoundary - 2);
    const separator = part.indexOf(Buffer.from('\r\n\r\n'));
    if (separator < 0) {
      cursor = nextBoundary;
      continue;
    }
    const headers = part.subarray(0, separator).toString('utf8');
    const content = part.subarray(separator + 4);
    const nameMatch = headers.match(/name="([^"]+)"/i);
    if (nameMatch?.[1] === 'image') {
      const filename = headers.match(/filename="([^"]*)"/i)?.[1] || 'cheque.jpg';
      const mimeType = headers.match(/content-type:\s*([^\r\n]+)/i)?.[1]?.trim() || 'application/octet-stream';
      return { buffer: content, filename, mimeType };
    }
    cursor = nextBoundary;
  }
  throw new Error('No se encontró el campo image en el formulario.');
}

async function readImage(req: Request): Promise<{ buffer: Buffer; filename: string; mimeType: string }> {
  const contentType = req.headers['content-type'] || '';
  console.log('[API Trace] readImage - contentType:', contentType);
  if (contentType.toLowerCase().includes('multipart/form-data')) return readMultipartImage(req);

  const body = req.body as { imageBase64?: string; filename?: string; mimeType?: string; origin?: string } | undefined;
  if (body?.imageBase64) {
    const match = body.imageBase64.match(/^data:([^;]+);base64,(.*)$/);
    const mimeType = match?.[1] || body.mimeType || 'image/jpeg';
    const buffer = Buffer.from(match?.[2] || body.imageBase64, 'base64');
    console.log('[API Trace] readImage (JSON/Base64) - filename:', body.filename, 'origin:', body.origin, 'base64Length:', body.imageBase64.length, 'bufferBytes:', buffer.length, 'mimeType:', mimeType);
    return { buffer, filename: body.filename || 'cheque.jpg', mimeType };
  }

  console.log('[API Trace] readImage - Error: No se recibió una imagen válida.');
  throw new Error('No se recibió una imagen válida.');
}

// Fase 1C: consulta BCRA desacoplada del request /analyze. Se dispara sin await luego de
// responder al cliente. NUNCA usa updateCheque()/determineInvalidation() (sección 8
// MASTERPLAN) — persiste directamente viá applyBcraResult(), que aplica la defensa de
// snapshot en cada escritura (sección 9 MASTERPLAN).
async function runBcraBackgroundJob(chequeId: string, extractedData: ValidatedChequeData, origin: string, requestId: string): Promise<void> {
  const snapshot: BcraSnapshot = {
    cuit: extractedData.cuit || null,
    cheque_numero: extractedData.cheque_numero || null,
    banco: extractedData.banco || null,
  };

  const appliedRunning = await chequeRepository.applyBcraResult(chequeId, { state: 'RUNNING', snapshot });
  if (!appliedRunning) {
    console.warn(`[BCRA background][${requestId}] snapshot ya no válido antes de arrancar; se aborta el job para ${chequeId}`);
    return;
  }

  try {
    const verified = await verifyWithBcra(extractedData);
    const bcraData = { ...verified.bcra, cuits_data: verified.cuits || [], origin };
    await chequeRepository.applyBcraResult(chequeId, { state: 'COMPLETED', snapshot, data: bcraData });
  } catch (error) {
    console.error(`[BCRA background][${requestId}] error consultando BCRA para ${chequeId}:`, error);
    const message = error instanceof Error ? error.message : String(error);
    const errorCode = /abort|timeout/i.test(message) ? 'timeout' : 'network_error';
    await chequeRepository.applyBcraResult(chequeId, { state: 'FAILED', snapshot, error: errorCode });
  }
}

export function registerChequeRoutes(app: Express) {
  app.get('/api/healthz', (_req: Request, res: Response) => {
    const mode = process.env.EXTRACTION_MODE || 'gemini_vision';
    const geminiKeyConfigured = Boolean(process.env.GEMINI_API_KEY && process.env.GEMINI_API_KEY.length > 5);
    res.json({
      status: 'ok',
      extractionMode: mode,
      tesseract: true,
      tesseractSpanish: true,
      geminiConfigured: geminiKeyConfigured,
      geminiModel: 'gemini-3.1-flash-lite',
      evaluationMode: String(process.env.EVALUATION_MODE).toLowerCase() === 'true',
    });
  });

  app.post('/api/extract-cheque', async (req: Request, res: Response) => {
    try {
      const { buffer, filename, mimeType } = await readImage(req);
      if (!isImageValid(filename, mimeType, buffer.length)) {
        return res.status(400).json({ error: 'La imagen no parece ser válida. Usá JPG, PNG o WEBP de hasta 10 MB.' });
      }
      // El cliente no puede seleccionar el pipeline: se determina exclusivamente por EXTRACTION_MODE.
      const result = await extractionService.extract(buffer, filename, undefined, mimeType);
      return res.json(result);
    } catch (error: any) {
      console.error('[API] extract-cheque error:', error);
      const message = error?.message || 'No pudimos interpretar los datos.';
      const status = message.includes('imagen') || message.includes('tamaño') || message.includes('formulario') ? 400 : 502;
      return res.status(status).json({ error: message });
    }
  });

  app.post('/api/quote', (req: Request, res: Response) => {
    try {
      const body = req.body || {};
      const amount = body.amount === null || body.amount === undefined || body.amount === '' ? null : Number(body.amount);
      const dueDate = body.dueDate === null || body.dueDate === undefined || body.dueDate === '' ? null : String(body.dueDate);
      const result = calculateQuote({ amount, dueDate, config: getQuoteConfig() });
      return res.json(result);
    } catch (error: any) {
      console.error('[API] quote configuration error:', error?.message || 'invalid configuration');
      return res.status(500).json({ error: 'La configuración de cotización no es válida.' });
    }
  });

  app.get('/api/evaluation/stats', (_req: Request, res: Response) => {
    const enabled = String(process.env.EVALUATION_MODE).toLowerCase() === 'true';
    if (!enabled) return res.status(404).json({ error: 'El modo evaluación no está habilitado.' });
    return res.json({ enabled: true, stats: evaluationService.getStats() });
  });

  app.post('/api/evaluation', (req: Request, res: Response) => {
    const enabled = String(process.env.EVALUATION_MODE).toLowerCase() === 'true';
    if (!enabled) return res.status(404).json({ error: 'El modo evaluación no está habilitado.' });
    try {
      const body = req.body || {};
      if (!body.data || typeof body.data !== 'object' || !body.groundTruth || typeof body.groundTruth !== 'object') {
        return res.status(400).json({ error: 'Se requieren data y groundTruth para evaluar el cheque.' });
      }
      const groundTruth: EvaluationGroundTruth = {
        cuit: body.groundTruth.cuit ?? null,
        cheque_numero: body.groundTruth.cheque_numero ?? null,
        importe: body.groundTruth.importe ?? null,
        fecha_pago: body.groundTruth.fecha_pago ?? null,
      };
      return res.status(201).json(evaluationService.evaluate(body.data, groundTruth));
    } catch (error: any) {
      return res.status(400).json({ error: error?.message || 'No se pudo evaluar el cheque.' });
    }
  });

  app.post('/api/cheques', async (req: Request, res: Response) => {
    try {
      const body = req.body || {};
      const cuitValidation = validateCuit(body.cuit);
      const importeValidation = normalizeImporte(body.importe);
      const fechaValidation = normalizeFecha(body.fecha_pago);
      const numeroValidation = normalizeNumeroCheque(body.cheque_numero);
      const confidence = body.confidence || {};
      const record = await chequeRepository.saveCheque({
        imageUrl: typeof body.imageUrl === 'string' ? body.imageUrl : '',
        cuit: formatCuit(body.cuit),
        cuitValidation: cuitValidation.status,
        chequeNumero: numeroValidation.value,
        banco: body.banco || null,
        importe: importeValidation.value,
        moneda: body.moneda || 'ARS',
        fechaPago: fechaValidation.value,
        librador: body.librador || null,
        ocrText: body.ocrText || '',
        confidence: {
          cuit: Number(confidence.cuit || 0),
          cheque_numero: Number(confidence.cheque_numero || 0),
          banco: Number(confidence.banco || 0),
          importe: Number(confidence.importe || 0),
          fecha_pago: Number(confidence.fecha_pago || 0),
          librador: Number(confidence.librador || 0),
        },
        extractionMode: body.extractionMode || process.env.EXTRACTION_MODE || 'mock',
        editedFields: Array.isArray(body.editedFields) ? body.editedFields : [],
      });
      return res.status(201).json(record);
    } catch (error: any) {
      console.error('[API] save cheque error:', error instanceof Error ? error.message : 'unknown error');
      if (error instanceof PersistenceError || error?.code === 'PERSISTENCE_ERROR') {
        return res.status(503).json({ error: 'No se pudo persistir el cheque en PostgreSQL. El cheque no fue guardado.' });
      }
      return res.status(400).json({ error: 'No pudimos registrar el cheque. Revisá los datos e intentá nuevamente.' });
    }
  });

  app.get('/api/cheques', async (req: Request, res: Response) => {
    try {
      const search = typeof req.query.search === 'string' ? req.query.search : undefined;
      const startDate = req.query.startDate ? Number(req.query.startDate) : undefined;
      const endDate = req.query.endDate ? Number(req.query.endDate) : undefined;
      const status = typeof req.query.status === 'string' ? req.query.status : undefined;
      const cheques = await chequeRepository.listCheques({ search, startDate, endDate, status });
      return res.json(cheques);
    } catch (error: any) {
      console.error('[API] list cheques error:', error);
      return res.status(500).json({ error: 'No se pudo obtener el historial de cheques.' });
    }
  });

  app.get('/api/cheques/:id', async (req: Request, res: Response) => {
    try {
      const record = await chequeRepository.getCheque(req.params.id);
      if (!record) return res.status(404).json({ error: 'Cheque no encontrado.' });
      return res.json(record);
    } catch (error: any) {
      console.error('[API] get cheque error:', error);
      return res.status(500).json({ error: 'No se pudo obtener el cheque.' });
    }
  });

  app.post('/api/cheques/analyze', async (req: Request, res: Response) => {
    const requestId = Math.random().toString(36).slice(2, 8);
    const analyzeStartedAt = performance.now();
    console.log(`[PERF][${requestId}] analyze START`);
    try {
      const readImageStartedAt = performance.now();
      const { buffer, filename, mimeType } = await readImage(req);
      console.log(`[PERF][${requestId}] readImage=${Math.round(performance.now() - readImageStartedAt)}ms`);
      if (!isImageValid(filename, mimeType, buffer.length)) {
        return res.status(400).json({ error: 'La imagen no parece ser válida. Usá JPG, PNG o WEBP de hasta 10 MB.' });
      }

      const queryOrigin = typeof req.query.origin === 'string' ? req.query.origin.toLowerCase() : '';
      const bodyOrigin = req.body && typeof req.body === 'object' && 'origin' in req.body ? String((req.body as any).origin).toLowerCase() : '';
      const headerOrigin = String(req.headers['x-cheque-origin'] || '').toLowerCase();

      const rawOrigin = queryOrigin || bodyOrigin || headerOrigin || 'web';
      const validOrigins = ['web', 'android', 'whatsapp', 'batch'];
      const origin = validOrigins.includes(rawOrigin) ? rawOrigin : 'web';

      // 1. Ejecutar extracción completa mediante pipeline Gemini / OCR.
      // Fase 1C: BCRA se salta acá (skipBcra) y se resuelve en background luego de responder.
      const extractionStartedAt = performance.now();
      const extraction = await extractionService.extract(buffer, filename, undefined, mimeType, requestId, { skipBcra: true });
      console.log(`[PERF][${requestId}] extraction=${Math.round(performance.now() - extractionStartedAt)}ms`);

      // 2. Calcular cotización opcional si hay importe y fecha
      let quoteResult = null;
      const quoteStartedAt = performance.now();
      try {
        if (extraction.data.importe !== null && extraction.data.fecha_pago) {
          quoteResult = calculateQuote({
            amount: extraction.data.importe,
            dueDate: extraction.data.fecha_pago,
            config: getQuoteConfig(),
          });
        }
      } catch (qErr) {
        console.warn('[API] analyze quote calculation warning:', qErr);
      }
      console.log(`[PERF][${requestId}] quote=${Math.round(performance.now() - quoteStartedAt)}ms`);

      // 3. Persistir en Supabase REST sin fallback a memoria
      const d = extraction.data;
      const primaryCuit = d.cuit || (d.cuits && d.cuits[0]?.cuit) || null;
      const primaryValidation = typeof d.cuit_validation === 'string' ? d.cuit_validation : (d.cuit_validation?.valid ? 'VALID' : 'INVALID');
      const numValidation = d.validation.cheque_numero;
      const impValidation = d.validation.importe;
      const fechaValidation = d.validation.fecha_pago;

      const supabaseStartedAt = performance.now();
      const record = await chequeRepository.saveCheque({
        imageUrl: '',
        cuit: formatCuit(primaryCuit),
        cuitValidation: typeof primaryValidation === 'string' ? primaryValidation : 'UNKNOWN',
        chequeNumero: numValidation.value,
        banco: d.banco || null,
        importe: impValidation.value,
        moneda: d.moneda || 'ARS',
        fechaPago: fechaValidation.value,
        librador: d.librador || null,
        ocrText: extraction.ocrText || '',
        confidence: d.finalConfidence || d.confidence || {},
        extractionMode: process.env.EXTRACTION_MODE || 'gemini_vision',
        editedFields: [],
        cuits: d.cuits || [],
        bcra: d.bcra || {},
        quote: quoteResult,
        origin: origin as 'web' | 'android' | 'whatsapp' | 'batch',
      });
      console.log(`[PERF][${requestId}] supabase=${Math.round(performance.now() - supabaseStartedAt)}ms`);

      const responseStartedAt = performance.now();
      const responseBody = {
        success: true,
        origin,
        extraction,
        quote: quoteResult,
        record,
      };
      console.log(`[PERF][${requestId}] response=${Math.round(performance.now() - responseStartedAt)}ms`);
      console.log(`[PERF][${requestId}] TOTAL=${Math.round(performance.now() - analyzeStartedAt)}ms`);
      res.status(201).json(responseBody);

      // Fase 1C: consulta BCRA en background, ya con la respuesta HTTP enviada.
      // .catch() explícito además del try/catch interno de runBcraBackgroundJob: nunca debe
      // quedar una unhandled promise rejection colgando en el proceso Node persistente.
      void runBcraBackgroundJob(record.id, d, origin, requestId).catch((error) => {
        console.error(`[BCRA background][${requestId}] job error no capturado:`, error);
      });
      return;
    } catch (error: any) {
      console.error(`[PERF][${requestId}] analyze ERROR total=${Math.round(performance.now() - analyzeStartedAt)}ms`);
      console.error('[API] analyze error:', error);
      const message = error?.message || 'No pudimos procesar ni persistir el cheque.';
      if (error instanceof PersistenceError || error?.code === 'PERSISTENCE_ERROR' || message.includes('Supabase REST')) {
        return res.status(503).json({ error: 'No se pudo persistir el cheque en Supabase REST. El cheque no fue guardado.' });
      }
      if (message.includes('imagen') || message.includes('tamaño') || message.includes('formulario') || message.includes('imagen válida')) {
        return res.status(400).json({ error: message });
      }
      return res.status(422).json({ error: message });
    }
  });

  app.patch('/api/cheques/:id', async (req: Request, res: Response) => {
    try {
      const body = req.body || {};
      const allowedKeys = ['cuit', 'chequeNumero', 'banco', 'librador', 'importe', 'fechaPago', 'moneda'];
      const updates: any = {};
      
      for (const key of allowedKeys) {
        if (key in body) {
          updates[key] = body[key];
        }
      }

      if (Object.keys(updates).length === 0) {
        return res.status(400).json({ error: 'Ningún campo válido provisto para actualizar.' });
      }

      const updated = await chequeRepository.updateCheque(req.params.id, updates);
      if (!updated) return res.status(404).json({ error: 'Cheque no encontrado para actualizar.' });
      return res.json(updated);
    } catch (error: any) {
      console.error('[API] update cheque error:', error);
      return res.status(400).json({ error: 'No se pudo actualizar el cheque.' });
    }
  });
}

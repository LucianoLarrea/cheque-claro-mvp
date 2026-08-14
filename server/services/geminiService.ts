import fs from 'fs';
import path from 'path';
import { formatCuit } from './validationService';

export interface CuitDetail {
  cuit: string;
  role: 'primary' | 'associated';
  evidence?: string | null;
}

export interface ExtractedChequeData {
  cuit: string | null;
  cuit_evidence: string | null;
  cuits: CuitDetail[];
  cheque_numero: string | null;
  cheque_numero_evidence: string | null;
  banco: string | null;
  importe: number | null;
  importe_evidence: string | null;
  moneda: string;
  fecha_pago: string | null;
  fecha_evidence: string | null;
  librador: string | null;
  confidence: {
    cuit: number;
    cheque_numero: number;
    banco: number;
    importe: number;
    fecha_pago: number;
    librador: number;
  };
}

export interface ChequeBoundingBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface VisionChequeData extends ExtractedChequeData {
  id: number;
  bbox: ChequeBoundingBox;
  partially_visible: boolean;
}

const SYSTEM_PROMPT = `
Eres un experto financiero en documentos bancarios de la República Argentina (cheques físicos y electrónicos echeqs).
Tu tarea es analizar la imagen o texto provisto y extraer con extrema precisión los datos estructurados. Cuando la imagen contenga más de un cheque, debes detectar cada cheque independiente, asignarle un id y bounding box normalizado (x, y, width, height entre 0 y 1), y mantener sus datos completamente separados.
PRIORIDAD ABSOLUTA: 1. CUIT, 2. Número de cheque, 3. Importe, 4. Fecha de pago.
REGLAS ESTRICTAS:
1. NO INVENTAR DATOS. Si un campo no es claramente legible, devuelve null y confianza baja (0.1).
2. CUIT: extrae el CUIT del librador o emisor (11 dígitos, con o sin guiones).
3. Número de cheque: preserva estrictamente los ceros iniciales.
4. Banco: identifica la entidad bancaria emisora.
5. Importe: devuelve número decimal puro sin símbolos de moneda.
6. Moneda: usa ARS por defecto.
7. Fecha de pago: normaliza a YYYY-MM-DD.
8. Librador: emisor o razón social.
9. Confidence: 0.0 a 1.0 por campo.
10. Ignora zonas que no sean cheques. Si un cheque está parcialmente visible, marca partially_visible=true y reduce la confianza; nunca completes datos faltantes por inferencia.
11. Para múltiples cheques devuelve exactamente un objeto por cheque visible y no combines campos de documentos distintos.
12. Devuelve evidencia textual sólo cuando sea visible en la imagen; si no es legible, devuelve null y confianza baja.
Devuelve únicamente un objeto JSON que cumpla el esquema solicitado.
`;

const CHEQUE_JSON_SCHEMA = {
  type: 'OBJECT',
  properties: {
    cuit: { type: 'STRING', nullable: true, description: 'CUIT principal, primer CUIT de la línea superior (compatibilidad PrestAdmin).' },
    cuit_evidence: { type: 'STRING', nullable: true },
    cuits: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          cuit: { type: 'STRING' },
          role: { type: 'STRING', enum: ['primary', 'associated'] },
          evidence: { type: 'STRING', nullable: true },
        },
        required: ['cuit', 'role'],
      },
      description: 'Todos los CUITs detectados en el cheque. El primero de la línea superior es primary, los demás associated.',
    },
    cheque_numero: { type: 'STRING', nullable: true, description: 'Número textual; preservar ceros iniciales.' },
    cheque_numero_evidence: { type: 'STRING', nullable: true },
    banco: { type: 'STRING', nullable: true },
    importe: { type: 'NUMBER', nullable: true },
    importe_evidence: { type: 'STRING', nullable: true },
    moneda: { type: 'STRING', enum: ['ARS', 'USD', 'EUR', 'OTRO'] },
    fecha_pago: { type: 'STRING', nullable: true },
    fecha_evidence: { type: 'STRING', nullable: true },
    librador: { type: 'STRING', nullable: true },
    confidence: {
      type: 'OBJECT',
      properties: {
        cuit: { type: 'NUMBER' },
        cheque_numero: { type: 'NUMBER' },
        banco: { type: 'NUMBER' },
        importe: { type: 'NUMBER' },
        fecha_pago: { type: 'NUMBER' },
        librador: { type: 'NUMBER' },
      },
      required: ['cuit', 'cheque_numero', 'banco', 'importe', 'fecha_pago', 'librador'],
    },
  },
  required: ['cuit', 'cheque_numero', 'banco', 'importe', 'moneda', 'fecha_pago', 'librador', 'confidence'],
};

function envModel() {
  return 'gemini-3.1-flash-lite';
}

function apiKey() {
  return process.env.GEMINI_API_KEY;
}

const MULTI_CHEQUE_JSON_SCHEMA = {
  type: 'OBJECT',
  properties: {
    cheques: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          id: { type: 'INTEGER' },
          bbox: {
            type: 'OBJECT',
            properties: {
              x: { type: 'NUMBER' },
              y: { type: 'NUMBER' },
              width: { type: 'NUMBER' },
              height: { type: 'NUMBER' },
            },
            required: ['x', 'y', 'width', 'height'],
          },
          partially_visible: { type: 'BOOLEAN' },
          cuit: { type: 'STRING', nullable: true },
          cuit_evidence: { type: 'STRING', nullable: true },
          cuits: {
            type: 'ARRAY',
            items: {
              type: 'OBJECT',
              properties: {
                cuit: { type: 'STRING' },
                role: { type: 'STRING', enum: ['primary', 'associated'] },
                evidence: { type: 'STRING', nullable: true },
              },
              required: ['cuit', 'role'],
            },
          },
          cheque_numero: { type: 'STRING', nullable: true },
          cheque_numero_evidence: { type: 'STRING', nullable: true },
          banco: { type: 'STRING', nullable: true },
          importe: { type: 'NUMBER', nullable: true },
          importe_evidence: { type: 'STRING', nullable: true },
          moneda: { type: 'STRING', enum: ['ARS', 'USD', 'EUR', 'OTRO'] },
          fecha_pago: { type: 'STRING', nullable: true },
          fecha_evidence: { type: 'STRING', nullable: true },
          librador: { type: 'STRING', nullable: true },
          confidence: {
            type: 'OBJECT',
            properties: {
              cuit: { type: 'NUMBER' }, cheque_numero: { type: 'NUMBER' }, banco: { type: 'NUMBER' },
              importe: { type: 'NUMBER' }, fecha_pago: { type: 'NUMBER' }, librador: { type: 'NUMBER' },
            },
            required: ['cuit', 'cheque_numero', 'banco', 'importe', 'fecha_pago', 'librador'],
          },
        },
        required: ['id', 'bbox', 'partially_visible', 'cuit', 'cheque_numero', 'banco', 'importe', 'moneda', 'fecha_pago', 'librador', 'confidence'],
      },
    },
  },
  required: ['cheques'],
};

function parseGeminiText(payload: any): any {
  const parts = payload?.candidates?.[0]?.content?.parts || [];
  const text = parts.map((part: any) => part?.text || '').join('').trim();
  if (!text) throw new Error('Gemini no devolvió contenido interpretable.');
  const clean = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
  return JSON.parse(clean);
}

function mimeFromPath(filePath: string) {
  const extension = path.extname(filePath).toLowerCase();
  if (extension === '.png') return 'image/png';
  if (extension === '.webp') return 'image/webp';
  return 'image/jpeg';
}

export class GeminiService {
  private async generateContent<T>(parts: Array<Record<string, unknown>>, responseSchema: unknown, normalize: (raw: any) => T): Promise<T> {
    const key = apiKey();
    if (!key) throw new Error('GEMINI_API_KEY no está configurada en el backend. Configurá la clave en secretos.');

    console.log('GEMINI_STARTED');
    const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(envModel())}:generateContent?key=${encodeURIComponent(key)}`;
    let lastError: unknown;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        const response = await fetch(endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
            contents: [{ role: 'user', parts }],
            generationConfig: {
              temperature: 0.1,
              maxOutputTokens: 2800,
              responseMimeType: 'application/json',
              responseSchema,
            },
          }),
        });
        if (!response.ok) {
          const errorBody = await response.text();
          throw new Error(`Gemini API ${response.status}: ${errorBody.slice(0, 300)}`);
        }
        const result = normalize(parseGeminiText(await response.json()));
        console.log('GEMINI_COMPLETED');
        return result;
      } catch (error) {
        lastError = error;
        if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, 600 * (attempt + 1)));
      }
    }
    throw new Error(`Gemini no pudo interpretar el cheque después de 2 reintentos: ${(lastError as Error)?.message || 'error desconocido'}`);
  }

  async extractFromOcrText(ocrText: string): Promise<{ data: ExtractedChequeData; durationMs: number }> {
    const startTime = Date.now();
    const data = await this.generateContent([{ text: `Texto OCR del cheque:\n---\n${ocrText}\n---\nExtrae los campos con el esquema JSON.` }], CHEQUE_JSON_SCHEMA, (raw) => this.normalizeExtractedData(raw));
    return { data, durationMs: Date.now() - startTime };
  }

  async extractFromVision(imagePath: string): Promise<{ data: VisionChequeData[]; durationMs: number }> {
    const startTime = Date.now();
    const imageBase64 = fs.readFileSync(imagePath).toString('base64');
    const data = await this.generateContent([
      { text: 'Detecta todos los cheques argentinos independientes visibles en la imagen. Devuelve exactamente un objeto por cheque dentro de `cheques`, con bbox normalizado entre 0 y 1. No mezcles datos entre cheques, ignora fondos u otras zonas y no inventes datos. Si un cheque está parcialmente visible, indícalo y baja la confianza.' },
      { inline_data: { mime_type: mimeFromPath(imagePath), data: imageBase64 } },
    ], MULTI_CHEQUE_JSON_SCHEMA, (raw) => this.normalizeVisionData(raw));
    if (data.length === 0) throw new Error('Gemini no detectó ningún cheque independiente en la imagen.');
    return { data, durationMs: Date.now() - startTime };
  }

  private normalizeVisionData(raw: any): VisionChequeData[] {
    const list = Array.isArray(raw?.cheques) ? raw.cheques : [];
    const clampCoordinate = (value: unknown) => typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0;
    return list.map((item: any, index: number) => {
      const base = this.normalizeExtractedData(item);
      return {
        ...base,
        id: Number.isInteger(item?.id) && item.id > 0 ? item.id : index + 1,
        bbox: {
          x: clampCoordinate(item?.bbox?.x),
          y: clampCoordinate(item?.bbox?.y),
          width: clampCoordinate(item?.bbox?.width),
          height: clampCoordinate(item?.bbox?.height),
        },
        partially_visible: Boolean(item?.partially_visible),
      };
    });
  }

  private normalizeExtractedData(raw: any): ExtractedChequeData {
    const value = (key: keyof ExtractedChequeData, fallback: any = null) => raw?.[key] ?? fallback;
    const confidenceValue = (key: keyof ExtractedChequeData['confidence'], fallback: number) => {
      const candidate = raw?.confidence?.[key];
      return typeof candidate === 'number' && Number.isFinite(candidate) ? Math.max(0, Math.min(1, candidate)) : fallback;
    };
    let mainCuit = formatCuit(value('cuit'));
    const rawCuits = Array.isArray(raw?.cuits) ? raw.cuits : [];
    
    let formattedCuits: Array<{ cuit: string; role: 'primary' | 'associated'; evidence?: string | null }> = [];
    
    if (mainCuit) {
      formattedCuits.push({
        cuit: mainCuit,
        role: 'primary',
        evidence: value('cuit_evidence'),
      });
    }

    for (const item of rawCuits) {
      const formatted = formatCuit(item?.cuit || '');
      if (!formatted) continue;
      // Si ya existe en la lista, no duplicar
      if (formattedCuits.some((fc) => fc.cuit === formatted)) continue;
      const role = (formattedCuits.length === 0 && !mainCuit) ? 'primary' : 'associated';
      formattedCuits.push({
        cuit: formatted,
        role: role,
        evidence: item?.evidence || null,
      });
    }

    if (formattedCuits.length > 0 && !formattedCuits.some((c) => c.role === 'primary')) {
      formattedCuits[0].role = 'primary';
    }

    if (!mainCuit && formattedCuits.length > 0) {
      mainCuit = formattedCuits.find((c) => c.role === 'primary')?.cuit || formattedCuits[0].cuit;
    }

    return {
      cuit: mainCuit,
      cuit_evidence: value('cuit_evidence'),
      cuits: formattedCuits.length > 0 ? formattedCuits : (mainCuit ? [{ cuit: mainCuit, role: 'primary', evidence: value('cuit_evidence') }] : []),
      cheque_numero: value('cheque_numero') === null ? null : String(value('cheque_numero')),
      cheque_numero_evidence: value('cheque_numero_evidence'),
      banco: value('banco'),
      importe: typeof value('importe') === 'number' ? value('importe') : value('importe') === null ? null : Number(value('importe')),
      importe_evidence: value('importe_evidence'),
      moneda: value('moneda', 'ARS') || 'ARS',
      fecha_pago: value('fecha_pago'),
      fecha_evidence: value('fecha_evidence'),
      librador: value('librador'),
      confidence: {
        cuit: confidenceValue('cuit', 0.2),
        cheque_numero: confidenceValue('cheque_numero', 0.2),
        banco: confidenceValue('banco', 0.2),
        importe: confidenceValue('importe', 0.2),
        fecha_pago: confidenceValue('fecha_pago', 0.2),
        librador: confidenceValue('librador', 0.2),
      },
    };
  }

  getMockData(): ExtractedChequeData {
    return {
      cuit: '30-71122334-3', cuit_evidence: '30-71122334-3',
      cuits: [{ cuit: '30-71122334-3', role: 'primary', evidence: '30-71122334-3' }],
      cheque_numero: '00458922', cheque_numero_evidence: '00458922',
      banco: 'Santander Argentina',
      importe: 2500000, importe_evidence: '$ 2.500.000',
      moneda: 'ARS',
      fecha_pago: '2026-09-15', fecha_evidence: '15/09/2026',
      librador: 'TECNOLOGIA Y SISTEMAS S.R.L.',
      confidence: { cuit: 0.98, cheque_numero: 0.97, banco: 0.95, importe: 0.99, fecha_pago: 0.96, librador: 0.9 },
    };
  }
}

export const geminiService = new GeminiService();

import { ChequeRecord, ChequeRepository, ApplyBcraResultInput } from './services/chequeRepository';
import { determineInvalidation } from './services/invalidationService';
import { buildBcraRiskLevel, compareBcraTitular } from './services/bcraService';
import { calculateQuote } from './services/quoteService';

export class PersistenceError extends Error {
  readonly code = 'PERSISTENCE_ERROR';

  constructor(operation: string, cause?: unknown) {
    super(`No se pudo ${operation} en Supabase REST.`);
    this.name = 'PersistenceError';
    if (cause instanceof Error) {
      (this as Error & { cause?: unknown }).cause = cause;
    }
  }
}

function getSupabaseConfig() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    return null;
  }
  return {
    endpoint: url.replace(/\/$/, ''),
    key,
  };
}

function generateChequeId(): string {
  return `CHK-${Date.now()}-${Math.floor(Math.random() * 90000 + 10000)}`;
}

export class SupabaseRestChequeRepository implements ChequeRepository {
  private getHeaders(apiKey: string) {
    return {
      'Content-Type': 'application/json',
      'apikey': apiKey,
      'Authorization': `Bearer ${apiKey}`,
      'Prefer': 'return=representation',
    };
  }

  async saveCheque(data: Omit<ChequeRecord, 'id' | 'timestamp'>): Promise<ChequeRecord> {
    const config = getSupabaseConfig();
    if (!config) {
      throw new PersistenceError('guardar el cheque: SUPABASE_URL o SUPABASE_SERVICE_ROLE_KEY no están configuradas');
    }

    const timestamp = Date.now();
    const id = generateChequeId();
    const bcraData = typeof (data as any).bcra === 'object' && (data as any).bcra !== null ? { ...(data as any).bcra } : {};
    if ((data as any).cuits) {
      bcraData.cuits_data = (data as any).cuits;
    }
    if ((data as any).origin) {
      bcraData.origin = (data as any).origin;
    }

    const bcraHasContent = Object.keys(bcraData).length > 0;
    const bcraTotalFailure = bcraHasContent
      && bcraData.estados
      && bcraData.estados.deudas === 'error'
      && bcraData.estados.cheques_rechazados === 'error'
      && bcraData.estados.entidad === 'error';
    const bcraPayload = {
      state: !bcraHasContent ? 'NOT_STARTED' : (bcraTotalFailure ? 'FAILED' : 'COMPLETED'),
      snapshot: {
        cuit: data.cuit || null,
        cheque_numero: data.chequeNumero || null,
        banco: data.banco || null,
      },
      data: bcraData,
    };

    const payload: any = {
      id,
      timestamp,
      image_url: data.imageUrl || '',
      cuit: data.cuit || null,
      cuit_validation: data.cuitValidation || 'UNKNOWN',
      cheque_numero: data.chequeNumero || null,
      banco: data.banco || null,
      importe: data.importe !== null && data.importe !== undefined ? Number(data.importe) : null,
      moneda: data.moneda || 'ARS',
      fecha_pago: data.fechaPago || null,
      librador: data.librador || null,
      ocr_text: data.ocrText || '',
      confidence: data.confidence || {},
      extraction_mode: data.extractionMode || 'gemini_vision',
      edited_fields: data.editedFields || [],
      bcra_result: bcraPayload,
      quote_result: (data as any).quote || null,
      status: 'confirmado',
    };

    try {
      const response = await fetch(`${config.endpoint}/rest/v1/cheques`, {
        method: 'POST',
        headers: this.getHeaders(config.key),
        body: JSON.stringify(payload),
      });

      if (!response.ok) {
        const text = await response.text();
        throw new Error(`Supabase REST error HTTP ${response.status}: ${text}`);
      }

      const rows = await response.json();
      const row = Array.isArray(rows) ? rows[0] : rows;
      if (!row) {
        throw new Error('Supabase REST no devolvió el registro insertado.');
      }
      return this.mapRowToRecord(row);
    } catch (error) {
      console.error('[Supabase REST] Error saving cheque:', error instanceof Error ? error.message : 'unknown error');
      if (error instanceof PersistenceError) throw error;
      throw new PersistenceError('guardar el cheque en Supabase REST', error);
    }
  }

  async getCheque(id: string): Promise<ChequeRecord | null> {
    const config = getSupabaseConfig();
    if (!config) {
      throw new PersistenceError('obtener el cheque: SUPABASE_URL o SUPABASE_SERVICE_ROLE_KEY no están configuradas');
    }

    try {
      const response = await fetch(`${config.endpoint}/rest/v1/cheques?id=eq.${encodeURIComponent(id)}&select=*`, {
        method: 'GET',
        headers: {
          'apikey': config.key,
          'Authorization': `Bearer ${config.key}`,
        },
      });

      if (!response.ok) {
        const text = await response.text();
        throw new Error(`Supabase REST error HTTP ${response.status}: ${text}`);
      }

      const rows = await response.json();
      if (!Array.isArray(rows) || rows.length === 0) {
        return null;
      }
      return this.mapRowToRecord(rows[0]);
    } catch (error) {
      console.error('[Supabase REST] Error reading cheque:', error instanceof Error ? error.message : 'unknown error');
      throw new PersistenceError('obtener el cheque de Supabase REST', error);
    }
  }

  async updateCheque(id: string, updates: Partial<ChequeRecord>): Promise<ChequeRecord | null> {
    const config = getSupabaseConfig();
    if (!config) {
      throw new PersistenceError('actualizar el cheque: SUPABASE_URL o SUPABASE_SERVICE_ROLE_KEY no están configuradas');
    }

    const current = await this.getCheque(id);
    if (!current) return null;

    const fieldsToCheck = ['cuit', 'chequeNumero', 'banco', 'importe', 'fechaPago', 'librador'] as const;
    try {
      for (const field of fieldsToCheck) {
        if (updates[field] !== undefined && updates[field] !== current[field]) {
          await fetch(`${config.endpoint}/rest/v1/cheque_corrections`, {
            method: 'POST',
            headers: this.getHeaders(config.key),
            body: JSON.stringify({
              cheque_id: id,
              field_name: field,
              original_value: String(current[field] ?? ''),
              corrected_value: String(updates[field] ?? ''),
              timestamp: Date.now(),
            }),
          });
        }
      }

      const updated = { ...current, ...updates };

      const invalidation = determineInvalidation(current as unknown as Record<string, any>, updates as unknown as Record<string, any>);

      // Defensa de snapshot (sección 6 MASTERPLAN): comparamos contra el registro YA fusionado
      // (updated), no solo contra los campos presentes en `updates`. Esto cubre tanto el caso
      // "se está editando cuit/chequeNumero/banco ahora" como el caso "ya había un mismatch
      // preexistente entre bcra.snapshot y el valor vigente del cheque", aunque este PATCH
      // puntual no toque esos campos.
      const currentSnapshot = (current as any).bcra?.snapshot;
      const snapshotMismatch = currentSnapshot
        && ((updated.cuit ?? null) !== (currentSnapshot.cuit ?? null)
          || (updated.chequeNumero ?? null) !== (currentSnapshot.cheque_numero ?? null)
          || (updated.banco ?? null) !== (currentSnapshot.banco ?? null));
      if (snapshotMismatch) {
        invalidation.requiresBcraFetch = true;
      }

      let bcraResultToPersist: any = (current as any).bcra;
      if (invalidation.requiresBcraFetch) {
        bcraResultToPersist = {
          state: 'STALE',
          snapshot: {
            cuit: updated.cuit ?? null,
            cheque_numero: updated.chequeNumero ?? null,
            banco: updated.banco ?? null,
          },
          data: null,
        };
      } else if (invalidation.requiresBcraReinterpretation && bcraResultToPersist && bcraResultToPersist.data) {
        const existingData = bcraResultToPersist.data;
        const newTitularCoincide = compareBcraTitular(existingData.titular_bcra, updated.librador);
        const newNivel = buildBcraRiskLevel({
          titular_coincide: newTitularCoincide,
          situacion_crediticia: existingData.situacion_crediticia,
          cheques_rechazados: existingData.cheques_rechazados,
          cheque_denunciado: existingData.cheque_denunciado,
          entidad_bcra: existingData.entidad_bcra,
          estados: existingData.estados,
        });
        bcraResultToPersist = {
          ...bcraResultToPersist,
          data: {
            ...existingData,
            titular_coincide: newTitularCoincide,
            nivel: newNivel,
          },
        };
      }

      let quoteResultToPersist: any = (current as any).quote;
      if (invalidation.requiresQuoteRecalc) {
        quoteResultToPersist = calculateQuote({
          amount: updated.importe,
          dueDate: updated.fechaPago,
        });
      }

      const patchPayload: any = {
        cuit: updated.cuit,
        cuit_validation: updated.cuitValidation,
        cheque_numero: updated.chequeNumero,
        banco: updated.banco,
        importe: updated.importe,
        fecha_pago: updated.fechaPago,
        librador: updated.librador,
        edited_fields: updated.editedFields || [],
        bcra_result: bcraResultToPersist,
        quote_result: quoteResultToPersist,
      };

      const response = await fetch(`${config.endpoint}/rest/v1/cheques?id=eq.${encodeURIComponent(id)}`, {
        method: 'PATCH',
        headers: this.getHeaders(config.key),
        body: JSON.stringify(patchPayload),
      });

      if (!response.ok) {
        const text = await response.text();
        throw new Error(`Supabase REST error HTTP ${response.status}: ${text}`);
      }

      const rows = await response.json();
      const row = Array.isArray(rows) ? rows[0] : rows;
      if (!row) return null;
      return this.mapRowToRecord(row);
    } catch (error) {
      console.error('[Supabase REST] Error updating cheque:', error instanceof Error ? error.message : 'unknown error');
      throw new PersistenceError('actualizar el cheque en Supabase REST', error);
    }
  }

  async applyBcraResult(id: string, input: ApplyBcraResultInput): Promise<boolean> {
    const config = getSupabaseConfig();
    if (!config) {
      throw new PersistenceError('aplicar el resultado BCRA: SUPABASE_URL o SUPABASE_SERVICE_ROLE_KEY no están configuradas');
    }

    const current = await this.getCheque(id);
    if (!current) return false;

    // Defensa de carrera (sección 9 MASTERPLAN): comparamos contra el estado VIGENTE del
    // cheque en este instante, no contra bcra.snapshot (que puede haber sido pisado por un
    // PATCH de usuario intermedio que ya lo puso en STALE). Si no coincide, se descarta.
    const vigente = {
      cuit: current.cuit ?? null,
      cheque_numero: current.chequeNumero ?? null,
      banco: current.banco ?? null,
    };
    const mismatch = vigente.cuit !== (input.snapshot.cuit ?? null)
      || vigente.cheque_numero !== (input.snapshot.cheque_numero ?? null)
      || vigente.banco !== (input.snapshot.banco ?? null);
    if (mismatch) {
      console.warn(`[BCRA background] snapshot mismatch para ${id}, se descarta resultado (state=${input.state})`);
      return false;
    }

    const bcraPayload: any = {
      state: input.state,
      snapshot: input.snapshot,
      data: input.state === 'COMPLETED' ? input.data : null,
    };
    if (input.state === 'FAILED') {
      bcraPayload.error = input.error;
    }

    try {
      const response = await fetch(`${config.endpoint}/rest/v1/cheques?id=eq.${encodeURIComponent(id)}`, {
        method: 'PATCH',
        headers: this.getHeaders(config.key),
        body: JSON.stringify({ bcra_result: bcraPayload }),
      });

      if (!response.ok) {
        const text = await response.text();
        throw new Error(`Supabase REST error HTTP ${response.status}: ${text}`);
      }
      return true;
    } catch (error) {
      console.error('[Supabase REST] Error applying BCRA result:', error instanceof Error ? error.message : 'unknown error');
      if (error instanceof PersistenceError) throw error;
      throw new PersistenceError('aplicar el resultado BCRA en Supabase REST', error);
    }
  }

  async listCheques(filters?: { search?: string; startDate?: number; endDate?: number; status?: string }): Promise<ChequeRecord[]> {
    const config = getSupabaseConfig();
    if (!config) {
      throw new PersistenceError('listar los cheques: SUPABASE_URL o SUPABASE_SERVICE_ROLE_KEY no están configuradas');
    }

    try {
      let url = `${config.endpoint}/rest/v1/cheques?select=*&order=timestamp.desc&limit=200`;
      if (filters?.status) {
        url += `&status=eq.${encodeURIComponent(filters.status)}`;
      }
      if (filters?.startDate) {
        url += `&timestamp=gte.${filters.startDate}`;
      }
      if (filters?.endDate) {
        url += `&timestamp=lte.${filters.endDate}`;
      }

      const response = await fetch(url, {
        method: 'GET',
        headers: {
          'apikey': config.key,
          'Authorization': `Bearer ${config.key}`,
        },
      });

      if (!response.ok) {
        const text = await response.text();
        throw new Error(`Supabase REST error HTTP ${response.status}: ${text}`);
      }

      const rows = await response.json();
      if (!Array.isArray(rows)) return [];
      
      let records = rows.map((r) => this.mapRowToRecord(r));
      if (filters?.search) {
        const query = filters.search.toLowerCase();
        records = records.filter((r) =>
          (r.cuit && r.cuit.toLowerCase().includes(query)) ||
          (r.chequeNumero && r.chequeNumero.toLowerCase().includes(query)) ||
          (r.librador && r.librador.toLowerCase().includes(query)) ||
          (r.banco && r.banco.toLowerCase().includes(query))
        );
      }
      return records;
    } catch (error) {
      console.error('[Supabase REST] Error listing cheques:', error instanceof Error ? error.message : 'unknown error');
      throw new PersistenceError('listar los cheques de Supabase REST', error);
    }
  }

  private mapRowToRecord(row: any): ChequeRecord {
    const bcra = typeof row.bcra_result === 'string' ? JSON.parse(row.bcra_result) : row.bcra_result;
    const bcraData = bcra && bcra.data ? bcra.data : null;
    const cuitsFromBcra = bcraData && Array.isArray(bcraData.cuits_data) ? bcraData.cuits_data : null;
    const cuits = cuitsFromBcra || (Array.isArray(row.cuits) ? row.cuits : (row.cuit ? [{ cuit: row.cuit, role: 'primary' }] : []));
    const origin = bcraData && bcraData.origin ? bcraData.origin : (row.origin || 'web');

    return {
      id: row.id,
      timestamp: Number(row.timestamp),
      imageUrl: row.image_url || '',
      cuit: row.cuit || '',
      cuitValidation: row.cuit_validation || 'UNKNOWN',
      cuits,
      chequeNumero: row.cheque_numero || null,
      banco: row.banco || null,
      importe: row.importe !== null && row.importe !== undefined ? Number(row.importe) : null,
      moneda: row.moneda || 'ARS',
      fechaPago: row.fecha_pago || null,
      librador: row.librador || null,
      ocrText: row.ocr_text || '',
      confidence: typeof row.confidence === 'string' ? JSON.parse(row.confidence) : (row.confidence || {}),
      extractionMode: row.extraction_mode || 'gemini_vision',
      editedFields: typeof row.edited_fields === 'string' ? JSON.parse(row.edited_fields) : (row.edited_fields || []),
      bcra,
      quote: typeof row.quote_result === 'string' ? JSON.parse(row.quote_result) : row.quote_result,
      status: row.status || 'confirmado',
      origin,
    } as any;
  }
}

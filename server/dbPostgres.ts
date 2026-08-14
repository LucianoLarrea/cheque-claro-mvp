import { Pool, PoolClient } from 'pg';
import { ChequeRecord, ChequeRepository } from './services/chequeRepository';

let _pool: Pool | null = null;

export class PersistenceError extends Error {
  readonly code = 'PERSISTENCE_ERROR';

  constructor(operation: string, cause?: unknown) {
    super(`No se pudo ${operation} en PostgreSQL.`);
    this.name = 'PersistenceError';
    if (cause instanceof Error) {
      (this as Error & { cause?: unknown }).cause = cause;
    }
  }
}

export function getPostgresPool(): Pool | null {
  if (!_pool && process.env.SUPABASE_DATABASE_URL) {
    _pool = new Pool({
      connectionString: process.env.SUPABASE_DATABASE_URL,
      connectionTimeoutMillis: 10000,
      idleTimeoutMillis: 30000,
      max: 5,
      ssl: { rejectUnauthorized: false },
    });
    _pool.on('error', (error) => {
      console.error('[PostgreSQL] Pool error:', error instanceof Error ? error.message : 'unknown error');
    });
    console.log('[PostgreSQL] Pool initialized for Supabase');
  }
  return _pool;
}

function generateChequeId(): string {
  return `CHK-${Date.now()}-${Math.floor(Math.random() * 90000 + 10000)}`;
}

export class PostgresChequeRepository implements ChequeRepository {
  private async getClient(): Promise<PoolClient> {
    const pool = getPostgresPool();
    if (!pool) {
      throw new PersistenceError('guardar el cheque: SUPABASE_DATABASE_URL no está configurada');
    }
    try {
      return await pool.connect();
    } catch (error) {
      throw new PersistenceError('conectarse a PostgreSQL', error);
    }
  }

  async saveCheque(data: Omit<ChequeRecord, 'id' | 'timestamp'>): Promise<ChequeRecord> {
    const timestamp = Date.now();
    const client = await this.getClient();
    try {
      const id = generateChequeId();
      const query = `
        INSERT INTO cheques (
          id, timestamp, image_url, cuit, cuit_validation, cheque_numero,
          banco, importe, moneda, fecha_pago, librador, ocr_text,
          confidence, extraction_mode, edited_fields, bcra_result, quote_result, status
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)
        RETURNING *;
      `;
      const values = [
        id,
        timestamp,
        data.imageUrl || '',
        data.cuit || null,
        data.cuitValidation || 'UNKNOWN',
        data.chequeNumero || null,
        data.banco || null,
        data.importe !== null && data.importe !== undefined ? data.importe : null,
        data.moneda || 'ARS',
        data.fechaPago || null,
        data.librador || null,
        data.ocrText || '',
        JSON.stringify(data.confidence || {}),
        data.extractionMode || 'gemini_vision',
        JSON.stringify(data.editedFields || []),
        JSON.stringify((data as any).bcra || null),
        JSON.stringify((data as any).quote || null),
        'confirmado',
      ];
      const result = await client.query(query, values);
      if (result.rows.length === 0) throw new Error('INSERT no devolvió ninguna fila.');
      return this.mapRowToRecord(result.rows[0]);
    } catch (error) {
      console.error('[PostgreSQL] Error saving cheque:', error instanceof Error ? error.message : 'unknown error');
      if (error instanceof PersistenceError) throw error;
      throw new PersistenceError('guardar el cheque', error);
    } finally {
      client.release();
    }
  }

  async getCheque(id: string): Promise<ChequeRecord | null> {
    const client = await this.getClient();
    try {
      const result = await client.query('SELECT * FROM cheques WHERE id = $1', [id]);
      if (result.rows.length === 0) return null;
      return this.mapRowToRecord(result.rows[0]);
    } catch (error) {
      console.error('[PostgreSQL] Error reading cheque:', error instanceof Error ? error.message : 'unknown error');
      throw new PersistenceError('obtener el cheque', error);
    } finally {
      client.release();
    }
  }

  async updateCheque(id: string, updates: Partial<ChequeRecord>): Promise<ChequeRecord | null> {
    const client = await this.getClient();
    try {
      const currentResult = await client.query('SELECT * FROM cheques WHERE id = $1', [id]);
      if (currentResult.rows.length === 0) return null;
      const current = this.mapRowToRecord(currentResult.rows[0]);

      const fieldsToCheck = ['cuit', 'chequeNumero', 'banco', 'importe', 'fechaPago', 'librador'] as const;
      for (const field of fieldsToCheck) {
        if (updates[field] !== undefined && updates[field] !== current[field]) {
          await client.query(
            `INSERT INTO cheque_corrections (cheque_id, field_name, original_value, corrected_value, timestamp) VALUES ($1, $2, $3, $4, $5)`,
            [id, field, String(current[field] ?? ''), String(updates[field] ?? ''), Date.now()],
          );
        }
      }

      const updated = { ...current, ...updates };
      const result = await client.query(
        `
          UPDATE cheques SET
            cuit = $2, cuit_validation = $3, cheque_numero = $4, banco = $5,
            importe = $6, fecha_pago = $7, librador = $8, edited_fields = $9
          WHERE id = $1
          RETURNING *;
        `,
        [
          id,
          updated.cuit,
          updated.cuitValidation,
          updated.chequeNumero,
          updated.banco,
          updated.importe,
          updated.fechaPago,
          updated.librador,
          JSON.stringify(updated.editedFields || []),
        ],
      );
      if (result.rows.length === 0) return null;
      return this.mapRowToRecord(result.rows[0]);
    } catch (error) {
      console.error('[PostgreSQL] Error updating cheque:', error instanceof Error ? error.message : 'unknown error');
      throw new PersistenceError('actualizar el cheque', error);
    } finally {
      client.release();
    }
  }

  async listCheques(filters?: { search?: string; startDate?: number; endDate?: number; status?: string }): Promise<ChequeRecord[]> {
    const client = await this.getClient();
    try {
      let sql = 'SELECT * FROM cheques WHERE 1=1';
      const params: Array<string | number> = [];
      let index = 1;

      if (filters?.search) {
        sql += ` AND (cuit ILIKE $${index} OR cheque_numero ILIKE $${index} OR librador ILIKE $${index} OR banco ILIKE $${index})`;
        params.push(`%${filters.search}%`);
        index += 1;
      }
      if (filters?.startDate) {
        sql += ` AND timestamp >= $${index}`;
        params.push(filters.startDate);
        index += 1;
      }
      if (filters?.endDate) {
        sql += ` AND timestamp <= $${index}`;
        params.push(filters.endDate);
        index += 1;
      }
      if (filters?.status) {
        sql += ` AND status = $${index}`;
        params.push(filters.status);
        index += 1;
      }

      sql += ' ORDER BY timestamp DESC LIMIT 200';
      const result = await client.query(sql, params);
      return result.rows.map((row) => this.mapRowToRecord(row));
    } catch (error) {
      console.error('[PostgreSQL] Error listing cheques:', error instanceof Error ? error.message : 'unknown error');
      throw new PersistenceError('listar los cheques', error);
    } finally {
      client.release();
    }
  }

  private mapRowToRecord(row: any): ChequeRecord {
    return {
      id: row.id,
      timestamp: Number(row.timestamp),
      imageUrl: row.image_url || '',
      cuit: row.cuit || null,
      cuitValidation: row.cuit_validation || 'UNKNOWN',
      chequeNumero: row.cheque_numero || null,
      banco: row.banco || null,
      importe: row.importe !== null && row.importe !== undefined ? Number(row.importe) : null,
      moneda: row.moneda || 'ARS',
      fechaPago: row.fecha_pago || null,
      librador: row.librador || null,
      ocrText: row.ocr_text || '',
      confidence: typeof row.confidence === 'string' ? JSON.parse(row.confidence) : (row.confidence || { cuit: 1, cheque_numero: 1, banco: 1, importe: 1, fecha_pago: 1, librador: 1 }),
      extractionMode: row.extraction_mode || 'gemini_vision',
      editedFields: typeof row.edited_fields === 'string' ? JSON.parse(row.edited_fields) : (row.edited_fields || []),
      bcra: typeof row.bcra_result === 'string' ? JSON.parse(row.bcra_result) : row.bcra_result,
      quote: typeof row.quote_result === 'string' ? JSON.parse(row.quote_result) : row.quote_result,
      status: row.status || 'confirmado',
    } as any;
  }
}

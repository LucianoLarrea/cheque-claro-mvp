import { SupabaseRestChequeRepository } from '../dbSupabaseRest';

export interface ChequeRecord {
  id: string;
  timestamp: number;
  imageUrl: string;
  cuit: string | null;
  cuitValidation: 'VALID' | 'INVALID' | 'UNKNOWN';
  cuits?: Array<{ cuit: string; role: 'primary' | 'associated'; evidence?: string | null; validation?: any; bcra?: any }>;
  chequeNumero: string | null;
  banco: string | null;
  importe: number | null;
  moneda: string;
  fechaPago: string | null;
  librador: string | null;
  ocrText: string;
  confidence: {
    cuit: number;
    cheque_numero: number;
    banco: number;
    importe: number;
    fecha_pago: number;
    librador: number;
  };
  extractionMode: string;
  editedFields: string[];
  bcra?: any;
  quote?: any;
  status?: string;
  origin?: 'web' | 'android' | 'whatsapp' | 'batch';
}

export interface ChequeRepository {
  saveCheque(cheque: Omit<ChequeRecord, 'id' | 'timestamp'>): Promise<ChequeRecord>;
  getCheque(id: string): Promise<ChequeRecord | null>;
  updateCheque(id: string, updates: Partial<ChequeRecord>): Promise<ChequeRecord | null>;
  listCheques(filters?: { search?: string; startDate?: number; endDate?: number; status?: string }): Promise<ChequeRecord[]>;
}

export class InMemoryChequeRepository implements ChequeRepository {
  private cheques: Map<string, ChequeRecord> = new Map();
  private counter = 1;

  async saveCheque(data: Omit<ChequeRecord, 'id' | 'timestamp'>): Promise<ChequeRecord> {
    const id = `CHK-${this.counter.toString().padStart(6, '0')}`;
    this.counter++;
    const record: ChequeRecord = {
      ...data,
      id,
      timestamp: Date.now(),
    };
    this.cheques.set(id, record);
    return record;
  }

  async getCheque(id: string): Promise<ChequeRecord | null> {
    return this.cheques.get(id) || null;
  }

  async updateCheque(id: string, updates: Partial<ChequeRecord>): Promise<ChequeRecord | null> {
    const existing = this.cheques.get(id);
    if (!existing) return null;
    const updated: ChequeRecord = {
      ...existing,
      ...updates,
    };
    this.cheques.set(id, updated);
    return updated;
  }

  async listCheques(filters?: { search?: string; startDate?: number; endDate?: number; status?: string }): Promise<ChequeRecord[]> {
    let list = Array.from(this.cheques.values());
    if (filters?.search) {
      const q = filters.search.toLowerCase();
      list = list.filter(item => 
        (item.cuit && item.cuit.toLowerCase().includes(q)) ||
        (item.chequeNumero && item.chequeNumero.toLowerCase().includes(q)) ||
        (item.librador && item.librador.toLowerCase().includes(q)) ||
        (item.banco && item.banco.toLowerCase().includes(q))
      );
    }
    if (filters?.status) {
      list = list.filter(item => item.status === filters.status);
    }
    return list.sort((a, b) => b.timestamp - a.timestamp);
  }
}

export const chequeRepository: ChequeRepository = new SupabaseRestChequeRepository();

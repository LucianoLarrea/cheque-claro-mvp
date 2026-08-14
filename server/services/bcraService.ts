const BCRA_BASE_URL = 'https://api.bcra.gob.ar';
const DEFAULT_TIMEOUT_MS = 8_000;
const ENTITY_CACHE_TTL_MS = 60 * 60 * 1_000;

export type BcraQueryStatus =
  | 'ok'
  | 'sin_antecedentes'
  | 'no_encontrado'
  | 'entidad_no_resuelta'
  | 'no_consultado'
  | 'error';

export type BcraRiskLevel = 'sin_hallazgos' | 'requiere_revision' | 'alerta';

export interface BcraEntity {
  codigoEntidad: number;
  denominacion: string;
}

export interface BcraRejectedCheck {
  nroCheque: string | number | null;
  fechaRechazo: string | null;
  monto: number | null;
  fechaPago: string | null;
  fechaPagoMulta: string | null;
  estadoMulta: string | null;
  causal: string | null;
  entidad: number | string | null;
}

export interface BcraReportedCheckDetail {
  sucursal: number | null;
  numeroCuenta: number | null;
  causal: string | null;
}

export interface BcraVerification {
  titular_bcra: string | null;
  titular_coincide: boolean | null;
  situacion_crediticia: number | null;
  periodo: string | null;
  cheques_rechazados: {
    cantidad: number;
    detalle: BcraRejectedCheck[];
    estado: BcraQueryStatus;
  };
  cheque_denunciado: {
    denunciado: boolean | null;
    detalle: BcraReportedCheckDetail[];
    estado: BcraQueryStatus;
  };
  entidad_bcra: {
    codigoEntidad: number | null;
    denominacion: string | null;
    estado: BcraQueryStatus;
  };
  estados: {
    deudas: BcraQueryStatus;
    cheques_rechazados: BcraQueryStatus;
    entidad: BcraQueryStatus;
    cheque_denunciado: BcraQueryStatus;
  };
  nivel: BcraRiskLevel;
}

interface BcraDebtPeriod {
  periodo?: string | number;
  entidades?: Array<{ situacion?: number | string | null }>;
}

interface BcraDebtResponse {
  status?: number;
  results?: {
    denominacion?: string;
    periodos?: BcraDebtPeriod[];
  };
}

interface BcraRejectedResponse {
  status?: number;
  results?: {
    causales?: Array<{
      causal?: string;
      entidades?: Array<{
        entidad?: number | string;
        detalle?: Array<Record<string, unknown>>;
      }>;
    }>;
  };
}

interface BcraReportedResponse {
  status?: number;
  results?: {
    denunciado?: boolean;
    detalles?: Array<Record<string, unknown>>;
  };
}

interface BcraEntitiesResponse {
  status?: number;
  results?: Array<{ codigoEntidad?: number | string; denominacion?: string }>;
}

export interface EntityResolution {
  status: 'resolved' | 'entity_no_resuelta';
  entity: BcraEntity | null;
  candidates: BcraEntity[];
}

export interface BcraClientOptions {
  baseUrl?: string;
  timeoutMs?: number;
  entityCacheTtlMs?: number;
  fetchImpl?: typeof fetch;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object';
}

function asString(value: unknown): string | null {
  return typeof value === 'string' || typeof value === 'number' ? String(value) : null;
}

function asNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) return Number(value);
  return null;
}

export function normalizeBcraText(value: string | null | undefined): string {
  return (value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function compareBcraTitular(denominacion: string | null | undefined, librador: string | null | undefined): boolean | null {
  const left = normalizeBcraText(denominacion);
  const right = normalizeBcraText(librador);
  if (!left || !right) return null;
  return left === right;
}

export function resolveBcraEntity(banco: string | null | undefined, entities: BcraEntity[]): EntityResolution {
  const normalizedBank = normalizeBcraText(banco);
  if (!normalizedBank) return { status: 'entity_no_resuelta', entity: null, candidates: [] };

  const exact = entities.filter((entity) => normalizeBcraText(entity.denominacion) === normalizedBank);
  if (exact.length === 1) return { status: 'resolved', entity: exact[0], candidates: exact };
  if (exact.length > 1) return { status: 'entity_no_resuelta', entity: null, candidates: exact };

  const partial = entities.filter((entity) => {
    const normalizedEntity = normalizeBcraText(entity.denominacion);
    return normalizedEntity.includes(normalizedBank) || normalizedBank.includes(normalizedEntity);
  });
  return partial.length === 1
    ? { status: 'resolved', entity: partial[0], candidates: partial }
    : { status: 'entity_no_resuelta', entity: null, candidates: partial };
}

function parsePeriod(periodo: string | number | undefined): string | null {
  const value = asString(periodo);
  return value && /^\d{6}$/.test(value) ? value : null;
}

export function selectLatestDebtPeriod(periodos: BcraDebtPeriod[] | undefined): { periodo: string | null; situacion: number | null } {
  const candidates: Array<{ periodo: string; situacion: number[] }> = (periodos || [])
    .map((period): { periodo: string | null; situacion: number[] } => ({
      periodo: parsePeriod(period.periodo),
      situacion: (period.entidades || [])
        .map((entity) => asNumber(entity.situacion))
        .filter((value): value is number => value !== null),
    }))
    .filter((period): period is { periodo: string; situacion: number[] } => Boolean(period.periodo));
  if (!candidates.length) return { periodo: null, situacion: null };
  candidates.sort((a: { periodo: string }, b: { periodo: string }) => b.periodo.localeCompare(a.periodo));
  const latest = candidates[0];
  return { periodo: latest.periodo, situacion: latest.situacion.length ? Math.max(...latest.situacion) : null };
}

function emptyVerification(): BcraVerification {
  return {
    titular_bcra: null,
    titular_coincide: null,
    situacion_crediticia: null,
    periodo: null,
    cheques_rechazados: { cantidad: 0, detalle: [], estado: 'no_consultado' },
    cheque_denunciado: { denunciado: null, detalle: [], estado: 'no_consultado' },
    entidad_bcra: { codigoEntidad: null, denominacion: null, estado: 'no_consultado' },
    estados: { deudas: 'no_consultado', cheques_rechazados: 'no_consultado', entidad: 'no_consultado', cheque_denunciado: 'no_consultado' },
    nivel: 'requiere_revision',
  };
}

export function buildBcraRiskLevel(input: Pick<BcraVerification, 'titular_coincide' | 'situacion_crediticia' | 'cheques_rechazados' | 'cheque_denunciado' | 'entidad_bcra' | 'estados'>): BcraRiskLevel {
  if (input.cheque_denunciado.denunciado === true || input.cheques_rechazados.cantidad > 0 || (input.situacion_crediticia !== null && input.situacion_crediticia >= 3)) {
    return 'alerta';
  }
  if (
    input.titular_coincide === false ||
    input.situacion_crediticia === 2 ||
    input.entidad_bcra.estado === 'entidad_no_resuelta' ||
    Object.values(input.estados).some((status) => status === 'error')
  ) {
    return 'requiere_revision';
  }
  return 'sin_hallazgos';
}

export class BcraClient {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly entityCacheTtlMs: number;
  private readonly fetchImpl: typeof fetch;
  private entityCache: { expiresAt: number; entities: BcraEntity[] } | null = null;
  private entityRequest: Promise<BcraEntity[]> | null = null;

  constructor(options: BcraClientOptions = {}) {
    this.baseUrl = options.baseUrl || BCRA_BASE_URL;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.entityCacheTtlMs = options.entityCacheTtlMs ?? ENTITY_CACHE_TTL_MS;
    this.fetchImpl = options.fetchImpl || fetch;
  }

  clearEntityCache() {
    this.entityCache = null;
    this.entityRequest = null;
  }

  private async request<T>(path: string): Promise<{ status: number; body: T | null }> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(`${this.baseUrl}${path}`, { signal: controller.signal });
      let body: T | null = null;
      try {
        body = await response.json() as T;
      } catch {
        body = null;
      }
      return { status: response.status, body };
    } finally {
      clearTimeout(timeout);
    }
  }

  async getEntities(): Promise<BcraEntity[]> {
    if (this.entityCache && this.entityCache.expiresAt > Date.now()) return this.entityCache.entities;
    if (this.entityRequest) return this.entityRequest;
    this.entityRequest = (async () => {
      const response = await this.request<BcraEntitiesResponse>('/cheques/v1.0/entidades');
      if (response.status < 200 || response.status >= 300 || !response.body?.results) throw new Error(`BCRA entidades HTTP ${response.status}`);
      const entities = response.body.results
        .map((item) => ({ codigoEntidad: asNumber(item.codigoEntidad), denominacion: item.denominacion || '' }))
        .filter((item): item is BcraEntity => item.codigoEntidad !== null && Boolean(item.denominacion));
      this.entityCache = { expiresAt: Date.now() + this.entityCacheTtlMs, entities };
      return entities;
    })();
    try {
      return await this.entityRequest;
    } finally {
      this.entityRequest = null;
    }
  }

  async verifyCheque(input: { cuit: string; chequeNumero: string; banco: string | null; librador: string | null }): Promise<BcraVerification> {
    const result = emptyVerification();
    const [deudas, rechazados] = await Promise.allSettled([
      this.request<BcraDebtResponse>(`/centraldedeudores/v1.0/Deudas/${encodeURIComponent(input.cuit)}`),
      this.request<BcraRejectedResponse>(`/centraldedeudores/v1.0/Deudas/ChequesRechazados/${encodeURIComponent(input.cuit)}`),
    ]);

    if (deudas.status === 'fulfilled') {
      if (deudas.value.status === 404) {
        result.estados.deudas = 'sin_antecedentes';
      } else if (deudas.value.status >= 200 && deudas.value.status < 300 && deudas.value.body?.results) {
        const debtResults = deudas.value.body.results;
        result.titular_bcra = debtResults.denominacion || null;
        result.titular_coincide = compareBcraTitular(result.titular_bcra, input.librador);
        const latest = selectLatestDebtPeriod(debtResults.periodos);
        result.periodo = latest.periodo;
        result.situacion_crediticia = latest.situacion;
        result.estados.deudas = 'ok';
      } else {
        result.estados.deudas = 'error';
      }
    } else {
      result.estados.deudas = 'error';
    }

    if (rechazados.status === 'fulfilled') {
      if (rechazados.value.status === 404) {
        result.estados.cheques_rechazados = 'sin_antecedentes';
      } else if (rechazados.value.status >= 200 && rechazados.value.status < 300 && rechazados.value.body?.results) {
        const rejectedResults = rechazados.value.body.results;
        const detalle: BcraRejectedCheck[] = [];
        for (const causal of rejectedResults.causales || []) {
          for (const entity of causal.entidades || []) {
            for (const item of entity.detalle || []) {
              detalle.push({
                nroCheque: asString(item.nroCheque),
                fechaRechazo: asString(item.fechaRechazo),
                monto: asNumber(item.monto),
                fechaPago: asString(item.fechaPago),
                fechaPagoMulta: asString(item.fechaPagoMulta),
                estadoMulta: asString(item.estadoMulta),
                causal: causal.causal || null,
                entidad: entity.entidad ?? null,
              });
            }
          }
        }
        result.cheques_rechazados = { cantidad: detalle.length, detalle, estado: 'ok' };
        result.estados.cheques_rechazados = 'ok';
      } else {
        result.estados.cheques_rechazados = 'error';
      }
    } else {
      result.estados.cheques_rechazados = 'error';
    }

    try {
      const entities = await this.getEntities();
      const resolution = resolveBcraEntity(input.banco, entities);
      if (resolution.status !== 'resolved' || !resolution.entity) {
        result.entidad_bcra = { codigoEntidad: null, denominacion: null, estado: 'entidad_no_resuelta' };
        result.estados.entidad = 'entidad_no_resuelta';
        result.cheque_denunciado.estado = 'entidad_no_resuelta';
      } else {
        result.entidad_bcra = { codigoEntidad: resolution.entity.codigoEntidad, denominacion: resolution.entity.denominacion, estado: 'ok' };
        result.estados.entidad = 'ok';
        const reported = await this.request<BcraReportedResponse>(`/cheques/v1.0/denunciados/${encodeURIComponent(String(resolution.entity.codigoEntidad))}/${encodeURIComponent(input.chequeNumero)}`);
        if (reported.status === 404) {
          result.cheque_denunciado = { denunciado: false, detalle: [], estado: 'no_encontrado' };
          result.estados.cheque_denunciado = 'no_encontrado';
        } else if (reported.status >= 200 && reported.status < 300 && reported.body?.results) {
          const reportedResults = reported.body.results;
          const detalle = (reportedResults.detalles || []).map((item) => ({ sucursal: asNumber(item.sucursal), numeroCuenta: asNumber(item.numeroCuenta), causal: asString(item.causal) }));
          result.cheque_denunciado = { denunciado: reportedResults.denunciado === true, detalle, estado: reportedResults.denunciado === true ? 'ok' : 'no_encontrado' };
          result.estados.cheque_denunciado = result.cheque_denunciado.estado;
        } else {
          result.cheque_denunciado = { denunciado: null, detalle: [], estado: 'error' };
          result.estados.cheque_denunciado = 'error';
        }
      }
    } catch {
      result.entidad_bcra = { codigoEntidad: null, denominacion: null, estado: 'error' };
      result.estados.entidad = 'error';
      result.cheque_denunciado = { denunciado: null, detalle: [], estado: 'error' };
      result.estados.cheque_denunciado = 'error';
    }

    result.nivel = buildBcraRiskLevel(result);
    return result;
  }
}

export function buildSkippedBcraVerification(): BcraVerification {
  return emptyVerification();
}

export const bcraClient = new BcraClient();

export const QUOTE_DEFAULTS = {
  tasaMensual: 14,
  descuentoMinimo: 10,
} as const;

const QUOTE_RANGES = {
  tasaMensual: { min: 12, max: 15 },
  descuentoMinimo: { min: 8, max: 10 },
} as const;

export type QuoteConfig = {
  tasaMensual: number;
  descuentoMinimo: number;
};

export type QuoteResult =
  | {
      status: 'ready';
      dueDate: string;
      today: string;
      plazoDias: number;
      plazoTransicion: number;
      tasaMensual: number;
      descuentoMinimo: number;
      porcentaje: number;
      descuento: number;
      montoAPagar: number;
    }
  | { status: 'expired'; message: 'Cheque vencido' }
  | { status: 'incomplete'; message: string };

function parseConfigNumber(value: string | undefined, fallback: number, name: keyof typeof QUOTE_RANGES, envName: string): number {
  if (value === undefined || value.trim() === '') return fallback;
  const parsed = Number(value);
  const range = QUOTE_RANGES[name];
  if (!Number.isFinite(parsed) || parsed < range.min || parsed > range.max) {
    throw new Error(`${envName} debe estar entre ${range.min} y ${range.max}`);
  }
  return parsed;
}

export function getQuoteConfig(env: Record<string, string | undefined> = process.env): QuoteConfig {
  return {
    tasaMensual: parseConfigNumber(env.TASA_MENSUAL, QUOTE_DEFAULTS.tasaMensual, 'tasaMensual', 'TASA_MENSUAL'),
    descuentoMinimo: parseConfigNumber(env.DESCUENTO_MINIMO, QUOTE_DEFAULTS.descuentoMinimo, 'descuentoMinimo', 'DESCUENTO_MINIMO'),
  };
}

export function roundHalfUp(value: number, decimals = 2): number {
  if (!Number.isFinite(value)) return Number.NaN;
  const factor = 10 ** decimals;
  const scaled = value * factor;
  const adjustment = Number.EPSILON * Math.max(1, Math.abs(scaled));
  const rounded = scaled >= 0 ? Math.floor(scaled + 0.5 + adjustment) : Math.ceil(scaled - 0.5 - adjustment);
  return rounded / factor;
}

export function calculatePorcentaje(plazoDias: number, tasaMensual: number, descuentoMinimo: number): { porcentaje: number; plazoTransicion: number } {
  const plazoTransicion = Math.ceil((30 * descuentoMinimo) / tasaMensual);
  let porcentaje: number;
  if (plazoDias <= plazoTransicion) {
    porcentaje = descuentoMinimo + ((((plazoTransicion * tasaMensual) / 30 - descuentoMinimo) / plazoTransicion) * plazoDias);
  } else {
    porcentaje = (tasaMensual * plazoDias) / 30;
  }
  return { porcentaje, plazoTransicion };
}

function parseDateOnly(value: string | null | undefined): Date | null {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value ? null : date;
}

function formatDateOnly(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function differenceInUtcDays(later: Date, earlier: Date): number {
  return Math.round((later.getTime() - earlier.getTime()) / 86_400_000);
}

export function calculateQuote(input: {
  amount: number | null | undefined;
  dueDate: string | null | undefined;
  today?: string;
  config?: QuoteConfig;
}): QuoteResult {
  if (input.amount === null || input.amount === undefined) return { status: 'incomplete', message: 'Falta el importe del cheque' };
  if (!Number.isFinite(input.amount) || input.amount <= 0) return { status: 'incomplete', message: 'El importe del cheque no es válido' };
  if (!input.dueDate) return { status: 'incomplete', message: 'Falta la fecha de vencimiento' };

  const dueDate = parseDateOnly(input.dueDate);
  if (!dueDate) return { status: 'incomplete', message: 'La fecha de vencimiento no es válida' };
  const today = input.today ? parseDateOnly(input.today) : new Date();
  if (!today) return { status: 'incomplete', message: 'La fecha actual no es válida' };
  const todayDate = input.today ? today : new Date(`${formatDateOnly(today)}T00:00:00.000Z`);
  const plazoDias = differenceInUtcDays(dueDate, todayDate);
  if (plazoDias < 0) return { status: 'expired', message: 'Cheque vencido' };

  const config = input.config || getQuoteConfig();
  const { porcentaje, plazoTransicion } = calculatePorcentaje(plazoDias, config.tasaMensual, config.descuentoMinimo);
  const descuento = roundHalfUp(input.amount * porcentaje / 100, 2);
  const montoAPagar = roundHalfUp(input.amount - descuento, 2);

  return {
    status: 'ready',
    dueDate: formatDateOnly(dueDate),
    today: formatDateOnly(todayDate),
    plazoDias,
    plazoTransicion,
    tasaMensual: config.tasaMensual,
    descuentoMinimo: config.descuentoMinimo,
    porcentaje,
    descuento,
    montoAPagar,
  };
}

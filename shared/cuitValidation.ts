export type CuitValidationStatus = 'VALID' | 'INVALID' | 'UNKNOWN';

export type CuitValidationResult = {
  status: CuitValidationStatus;
  confidence: number;
  message: string;
  normalized: string | null;
  format_valid: boolean;
  check_digit: number | null;
  expected_check_digit: number | null;
  valid: boolean;
  special_case: boolean;
};

type SpecialAssignment = {
  sourcePrefix: string;
  assignedPrefix: string;
  checkDigit: number;
};

const CUIT_WEIGHTS = [5, 4, 3, 2, 7, 6, 5, 4, 3, 2] as const;

/**
 * Casos documentados del algoritmo CUIT/CUIL cuando el cálculo produce 10.
 * El identificador recibido nunca se corrige automáticamente: estas reglas
 * sólo permiten validar el prefijo/dígito que ARCA asigna en ese caso.
 */
const SPECIAL_ASSIGNMENTS: SpecialAssignment[] = [
  { sourcePrefix: '20', assignedPrefix: '23', checkDigit: 9 },
  { sourcePrefix: '27', assignedPrefix: '23', checkDigit: 4 },
  { sourcePrefix: '24', assignedPrefix: '23', checkDigit: 3 },
  { sourcePrefix: '30', assignedPrefix: '33', checkDigit: 9 },
  { sourcePrefix: '34', assignedPrefix: '33', checkDigit: 3 },
];

/** Quita únicamente guiones, espacios y puntos; no descarta letras u otros símbolos. */
export function normalizeCuit(input: string | null | undefined): string | null {
  if (input === null || input === undefined) return null;
  const value = String(input).trim();
  return value ? value.replace(/[\s.-]/g, '') : null;
}

function calculateStandardCheckDigit(prefix: string, body: string): { remainder: number; checkDigit: number | null } {
  const firstTen = `${prefix}${body}`;
  let sum = 0;
  for (let index = 0; index < CUIT_WEIGHTS.length; index += 1) {
    sum += Number(firstTen[index]) * CUIT_WEIGHTS[index];
  }

  const remainder = sum % 11;
  if (remainder === 0) return { remainder, checkDigit: 0 };
  if (remainder === 1) return { remainder, checkDigit: null };
  return { remainder, checkDigit: 11 - remainder };
}

function findSpecialAssignment(prefix: string, body: string): SpecialAssignment | null {
  return SPECIAL_ASSIGNMENTS.find((assignment) => {
    if (assignment.assignedPrefix !== prefix) return false;
    return calculateStandardCheckDigit(assignment.sourcePrefix, body).remainder === 1;
  }) || null;
}

function findSourceSpecialCase(prefix: string, body: string): SpecialAssignment | null {
  return SPECIAL_ASSIGNMENTS.find((assignment) => {
    if (assignment.sourcePrefix !== prefix) return false;
    return calculateStandardCheckDigit(prefix, body).remainder === 1;
  }) || null;
}

export function validateCuit(cuitStr: string | null | undefined): CuitValidationResult {
  const normalized = normalizeCuit(cuitStr);
  const formatValid = Boolean(normalized && /^\d{11}$/.test(normalized));

  if (!normalized) {
    return {
      status: 'UNKNOWN',
      confidence: 0.2,
      message: 'CUIT no detectado',
      normalized: null,
      format_valid: false,
      check_digit: null,
      expected_check_digit: null,
      valid: false,
      special_case: false,
    };
  }

  if (!formatValid) {
    return {
      status: 'INVALID',
      confidence: 0.3,
      message: 'Formato de CUIT inválido (debe tener exactamente 11 dígitos)',
      normalized,
      format_valid: false,
      check_digit: null,
      expected_check_digit: null,
      valid: false,
      special_case: false,
    };
  }

  const prefix = normalized.slice(0, 2);
  const body = normalized.slice(2, 10);
  const checkDigit = Number(normalized[10]);
  const standard = calculateStandardCheckDigit(prefix, body);
  const specialAssignment = findSpecialAssignment(prefix, body);
  const sourceSpecialCase = findSourceSpecialCase(prefix, body);
  const specialValid = Boolean(specialAssignment && checkDigit === specialAssignment.checkDigit);
  const valid = checkDigit === standard.checkDigit || specialValid;
  const expectedCheckDigit = specialValid ? specialAssignment!.checkDigit : standard.checkDigit ?? sourceSpecialCase?.checkDigit ?? null;

  if (valid) {
    return {
      status: 'VALID',
      confidence: 0.98,
      message: 'CUIT válido',
      normalized,
      format_valid: true,
      check_digit: checkDigit,
      expected_check_digit: expectedCheckDigit,
      valid: true,
      special_case: specialValid,
    };
  }

  const specialMessage = sourceSpecialCase
    ? `CUIT inválido: el caso especial requiere prefijo ${sourceSpecialCase.assignedPrefix} y dígito ${sourceSpecialCase.checkDigit}`
    : 'CUIT inválido (dígito verificador incorrecto)';

  return {
    status: 'INVALID',
    confidence: 0.4,
    message: specialMessage,
    normalized,
    format_valid: true,
    check_digit: checkDigit,
    expected_check_digit: expectedCheckDigit,
    valid: false,
    special_case: Boolean(sourceSpecialCase),
  };
}

export function formatCuit(cuitStr: string | null | undefined): string | null {
  if (!cuitStr) return null;
  const validation = validateCuit(cuitStr);
  if (!validation.format_valid || !validation.normalized) return String(cuitStr);
  return `${validation.normalized.slice(0, 2)}-${validation.normalized.slice(2, 10)}-${validation.normalized.slice(10)}`;
}

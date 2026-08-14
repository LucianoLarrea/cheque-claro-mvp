import { useEffect, useMemo, useRef, useState, type ChangeEvent, type DragEvent } from 'react';
import { AlertTriangle, Camera, Check, ChevronDown, ChevronUp, FileImage, Loader2, Pencil, RotateCcw, ShieldAlert, ShieldCheck, Sparkles, Upload, WandSparkles } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Separator } from '@/components/ui/separator';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';
import { validateCuit } from '@shared/cuitValidation';

type Step = 'upload' | 'preview' | 'processing' | 'results' | 'confirmed';
type CuitValidation = {
  status: 'VALID' | 'INVALID' | 'UNKNOWN';
  confidence: number;
  message: string;
  normalized: string | null;
  format_valid: boolean;
  check_digit: number | null;
  expected_check_digit: number | null;
  valid: boolean;
  special_case: boolean;
};
type BcraQueryStatus = 'ok' | 'sin_antecedentes' | 'no_encontrado' | 'entidad_no_resuelta' | 'no_consultado' | 'error';
type BcraVerification = {
  titular_bcra: string | null;
  titular_coincide: boolean | null;
  situacion_crediticia: number | null;
  periodo: string | null;
  cheques_rechazados: { cantidad: number; detalle: unknown[]; estado: BcraQueryStatus };
  cheque_denunciado: { denunciado: boolean | null; detalle: unknown[]; estado: BcraQueryStatus };
  entidad_bcra: { codigoEntidad: number | null; denominacion: string | null; estado: BcraQueryStatus };
  estados: { deudas: BcraQueryStatus; cheques_rechazados: BcraQueryStatus; entidad: BcraQueryStatus; cheque_denunciado: BcraQueryStatus };
  nivel: 'sin_hallazgos' | 'requiere_revision' | 'alerta';
};
type FieldName = 'cuit' | 'cheque_numero' | 'banco' | 'importe' | 'fecha_pago' | 'librador';
type ConfidenceLevel = 'Alta confianza' | 'Revisar' | 'Baja confianza';
type ConfidenceMap = Record<FieldName, number>;
type BBox = { x: number; y: number; width: number; height: number };
type QuoteResponse =
  | { status: 'loading' }
  | { status: 'ready'; dueDate: string; plazoDias: number; plazoTransicion: number; tasaMensual: number; porcentaje: number; descuento: number; montoAPagar: number }
  | { status: 'expired' | 'incomplete'; message: string };

type ExtractedData = {
  id?: number;
  bbox?: BBox;
  partially_visible?: boolean;
  cuit: string | null;
  cuit_evidence?: string | null;
  cuits?: Array<{ cuit: string; role: 'primary' | 'associated'; evidence?: string | null; validation?: CuitValidation; bcra?: BcraVerification }>;
  cheque_numero: string | null;
  cheque_numero_evidence?: string | null;
  banco: string | null;
  importe: number | null;
  importe_evidence?: string | null;
  moneda: string;
  fecha_pago: string | null;
  fecha_evidence?: string | null;
  librador: string | null;
  confidence: ConfidenceMap;
  finalConfidence?: ConfidenceMap;
  validation?: {
    cuit: CuitValidation;
    importe: { value: number | null; confidence: number; message: string };
    fecha_pago: { value: string | null; confidence: number; message: string };
    cheque_numero: { value: string | null; confidence: number; message: string };
  };
  cuit_validation?: CuitValidation;
  bcra?: BcraVerification;
};

type AnalysisResponse = { mode: string; data: ExtractedData; cheques?: ExtractedData[]; ocrText: string; debug?: { ocrDurationMs: number; geminiDurationMs: number }; comparison?: { ocrGemini: ExtractedData; geminiVision: ExtractedData } };
type EvaluationField = 'cuit' | 'cheque_numero' | 'importe' | 'fecha_pago';
type GroundTruth = Record<EvaluationField, string>;
type EvaluationStats = { processedCheques: number; precision: Record<EvaluationField, number>; correctByField: Record<EvaluationField, number>; corrections: number; humanInterventions: number; humanInterventionRate: number };
type EvaluationResult = { id: string; fields: Record<EvaluationField, { correct: boolean; geminiValue: string | number | null; realValue: string | number | null; evidence: string | null }>; corrections: number; stats: EvaluationStats };
type ConfirmedCheque = { id: string; timestamp: number; cuit: string | null; chequeNumero: string | null; importe: number | null; fechaPago: string | null };

const fieldLabels: Record<FieldName, string> = { cuit: 'CUIT', cheque_numero: 'N° de cheque', banco: 'Banco', importe: 'Importe', fecha_pago: 'Fecha de pago', librador: 'Librador' };
const evaluationFields: EvaluationField[] = ['cuit', 'cheque_numero', 'importe', 'fecha_pago'];
const emptyGroundTruth: GroundTruth = { cuit: '', cheque_numero: '', importe: '', fecha_pago: '' };

function confidenceLevel(value: number): ConfidenceLevel { if (value >= 0.9) return 'Alta confianza'; if (value >= 0.7) return 'Revisar'; return 'Baja confianza'; }
function confidenceTone(level: ConfidenceLevel) { return level === 'Alta confianza' ? 'confidence-high' : level === 'Revisar' ? 'confidence-review' : 'confidence-low'; }
function formatARS(value: number | null) { if (value === null || Number.isNaN(value)) return '—'; return new Intl.NumberFormat('es-AR', { style: 'currency', currency: 'ARS', maximumFractionDigits: 2 }).format(value); }
function displayDate(value: string | null) { if (!value) return '—'; const [year, month, day] = value.split('-'); return year && month && day ? `${day}/${month}/${year}` : value; }
function normalizeDateLocal(value: string | null) { if (!value) return null; const match = value.trim().match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{4})$/); if (!match) return value; const [, day, month, year] = match; return `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`; }
function normalizeAmountLocal(value: string | number | null) { if (value === null || value === '') return null; if (typeof value === 'number') return value; const clean = value.replace(/[$ARS\s]/g, ''); const normalized = clean.includes(',') ? clean.replace(/\./g, '').replace(',', '.') : clean.replace(/\.(?=\d{3}(?:\D|$))/g, ''); const result = Number(normalized); return Number.isFinite(result) ? result : null; }
function getPreviewField(data: ExtractedData, field: FieldName) { if (field === 'importe') return formatARS(data.importe); if (field === 'fecha_pago') return displayDate(data.fecha_pago); return data[field] || 'No detectado'; }
function getFileExtension(file: File) { return file.name.slice(file.name.lastIndexOf('.')).toLowerCase(); }
function identityFor(data: ExtractedData, index: number): ExtractedData { return { ...data, id: data.id ?? index + 1 }; }
function getCuitValidation(data: ExtractedData): CuitValidation | undefined { return data.cuit_validation || data.validation?.cuit; }
function bcraStatusLabel(status: BcraQueryStatus) { return status === 'ok' ? 'Consultado' : status === 'sin_antecedentes' ? 'Sin antecedentes' : status === 'no_encontrado' ? 'No encontrado' : status === 'entidad_no_resuelta' ? 'Entidad no resuelta' : status === 'no_consultado' ? 'No consultado' : 'Error de API'; }
function BcraPanel({ verification }: { verification: BcraVerification }) { const alert = verification.nivel === 'alerta'; const review = verification.nivel === 'requiere_revision'; const title = alert ? 'Alerta' : review ? 'Requiere revisión' : 'Sin hallazgos'; return <div className={cn('bcra-panel', alert ? 'bcra-alert' : review ? 'bcra-review' : 'bcra-clear')}><div className="bcra-panel-header"><div className="bcra-status-icon">{alert || review ? <ShieldAlert size={17} /> : <ShieldCheck size={17} />}</div><div><span className="card-kicker">verificación BCRA</span><strong>{title}</strong></div></div><div className="bcra-summary-grid"><div><span>Titular BCRA</span><strong>{verification.titular_bcra || '—'}</strong></div><div><span>Coincidencia</span><strong>{verification.titular_coincide === null ? 'No evaluable' : verification.titular_coincide ? 'Coincide' : 'No coincide'}</strong></div><div><span>Situación crediticia</span><strong>{verification.situacion_crediticia ?? '—'}{verification.periodo ? ` · ${verification.periodo}` : ''}</strong></div><div><span>Cheques rechazados</span><strong>{verification.cheques_rechazados.cantidad}</strong></div><div><span>Entidad</span><strong>{verification.entidad_bcra.denominacion || bcraStatusLabel(verification.entidad_bcra.estado)}</strong></div><div><span>Cheque denunciado</span><strong>{verification.cheque_denunciado.denunciado === true ? 'Sí' : verification.cheque_denunciado.estado === 'no_encontrado' ? 'No encontrado' : '—'}</strong></div></div><div className="bcra-query-statuses"><span>Deudas: {bcraStatusLabel(verification.estados.deudas)}</span><span>Rechazados: {bcraStatusLabel(verification.estados.cheques_rechazados)}</span><span>Entidad: {bcraStatusLabel(verification.estados.entidad)}</span><span>Denuncia: {bcraStatusLabel(verification.estados.cheque_denunciado)}</span></div><p className="bcra-disclaimer">La consulta BCRA informa hallazgos disponibles al momento de la verificación. “No encontrado como denunciado” no significa que el cheque esté garantizado como legítimo.</p></div> }

function QuotePanel({ data, quote, onQuote }: { data: ExtractedData; quote?: QuoteResponse; onQuote: () => void }) {
  const canQuote = data.importe !== null && Boolean(data.fecha_pago);
  return <div className="quote-panel"><div className="quote-panel-header"><div><span className="card-kicker">cotización opcional</span><strong>💰 COTIZACIÓN</strong></div><Button type="button" className="secondary-button quote-button" onClick={onQuote} disabled={!canQuote || quote?.status === 'loading'}>💰 Cotizar descuento</Button></div>{!canQuote && <p className="quote-helper">Necesitás importe y fecha de vencimiento para cotizar.</p>}{quote?.status === 'loading' && <p className="quote-helper">Calculando cotización con la fecha actual del servidor…</p>}{quote?.status === 'expired' && <p className="quote-warning">{quote.message}</p>}{quote?.status === 'incomplete' && <p className="quote-warning">{quote.message}</p>}{quote?.status === 'ready' && <div className="quote-result"><div className="quote-grid"><div><span>Valor nominal</span><strong>{formatARS(data.importe)}</strong></div><div><span>Vencimiento</span><strong>{displayDate(quote.dueDate)}</strong></div><div><span>Plazo</span><strong>{quote.plazoDias} días</strong></div><div><span>Tasa mensual</span><strong>{quote.tasaMensual}%</strong></div><div><span>Descuento</span><strong>{quote.porcentaje.toFixed(2)}%</strong></div><div><span>Importe descuento</span><strong>{formatARS(quote.descuento)}</strong></div></div><div className="quote-payable"><span>💵 Valor a pagar hoy</span><strong>{formatARS(quote.montoAPagar)}</strong></div><p className="quote-transition">Plazo de transición: <strong>{quote.plazoTransicion} días</strong></p></div>}</div>
}

function ChequeResultCard({ data, editedFields, confirmed, quote, onUpdate, onQuote, onConfirm }: { data: ExtractedData; editedFields: FieldName[]; confirmed?: ConfirmedCheque; quote?: QuoteResponse; onUpdate: (field: FieldName, value: string) => void; onQuote: () => void; onConfirm: () => void }) {
  const visibleConfidence = data.finalConfidence || data.confidence;
  const cuitValidation = getCuitValidation(data);
  return <Card className="data-card cheque-result-card"><div className="data-card-header"><div><span className="card-kicker">CHEQUE {data.id}</span><h2>Datos del cheque</h2></div><div className="data-card-icon"><ShieldCheck size={20} /></div></div>{data.bbox && <div className="bbox-meta">Área detectada · x {Math.round(data.bbox.x * 100)}% · y {Math.round(data.bbox.y * 100)}% · {Math.round(data.bbox.width * 100)}% × {Math.round(data.bbox.height * 100)}%{data.partially_visible ? ' · parcial' : ''}</div>}<Separator /><div className="fields-grid">{(Object.keys(fieldLabels) as FieldName[]).map((field) => { const confidence = visibleConfidence[field] || 0; const level = confidenceLevel(confidence); const edited = editedFields.includes(field); const inputValue = data[field] ?? ''; return <div className={cn('field-row', edited && 'field-edited')} key={field}><div className="field-label"><Label>{fieldLabels[field]}</Label>{edited && <span className="edited-chip">Editado manualmente</span>}</div><div className="field-value-line"><Input value={String(inputValue)} onChange={(event) => onUpdate(field, event.target.value)} placeholder="No detectado" className="result-input" inputMode={field === 'importe' ? 'decimal' : field === 'cheque_numero' ? 'numeric' : undefined} /><span className={cn('confidence-pill', confidenceTone(level))}><span className="confidence-dot" />{edited ? 'Editado' : `${level} · ${Math.round(confidence * 100)}%`}</span></div>{field === 'cuit' && cuitValidation && <div className={cn('validation-note', cuitValidation.status === 'VALID' ? 'valid' : cuitValidation.status === 'UNKNOWN' ? 'invalid' : 'invalid')}>{cuitValidation.status === 'VALID' ? <Check size={14} /> : <AlertTriangle size={14} />} <span>{cuitValidation.status === 'VALID' ? 'CUIT válido' : cuitValidation.status === 'UNKNOWN' ? 'CUIT no detectado' : 'CUIT inválido — revisar'}</span>{cuitValidation.format_valid && cuitValidation.check_digit !== null && cuitValidation.expected_check_digit !== null && cuitValidation.status === 'INVALID' && <span className="validation-detail">Dígito esperado: <strong>{cuitValidation.expected_check_digit}</strong> · Detectado: <strong>{cuitValidation.check_digit}</strong></span>}</div>}{field === 'importe' && <div className="field-display-hint">Vista formateada: <strong>{formatARS(data.importe)}</strong>{data.importe_evidence && <> · Evidencia: <strong>{data.importe_evidence}</strong></>}</div>}{field === 'fecha_pago' && <div className="field-display-hint">Vista formateada: <strong>{displayDate(data.fecha_pago)}</strong>{data.fecha_evidence && <> · Evidencia: <strong>{data.fecha_evidence}</strong></>}</div>}{field === 'cuit' && data.cuit_evidence && <div className="field-display-hint">Evidencia: <strong>{data.cuit_evidence}</strong></div>}{field === 'cheque_numero' && data.cheque_numero_evidence && <div className="field-display-hint">Evidencia: <strong>{data.cheque_numero_evidence}</strong></div>}</div>; })}</div>{data.bcra && Object.values(data.bcra.estados).some((status) => status !== 'no_consultado') && <BcraPanel verification={data.bcra} />}
{data.cuits && data.cuits.filter((c: any) => c.role === 'associated').length > 0 && (
  <div className="associated-cuits-section" style={{ marginTop: '1.25rem', padding: '1rem', background: 'rgba(255,255,255,0.03)', border: '1px solid var(--border)', borderRadius: '0.75rem' }}>
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '0.75rem' }}>
      <span className="card-kicker">cuits asociados</span>
      <span style={{ fontSize: '0.8rem', padding: '0.15rem 0.5rem', background: 'var(--muted)', borderRadius: '999px' }}>
        {data.cuits.filter((c: any) => c.role === 'associated').length} asociados
      </span>
    </div>
    {data.cuits.filter((c: any) => c.role === 'associated').map((associated: any, index: number) => {
      const val = associated.validation || validateCuit(associated.cuit);
      return (
        <div key={associated.cuit || index} style={{ marginBottom: index > 0 ? '1rem' : 0, paddingBottom: index > 0 ? '1rem' : 0, borderBottom: index > 0 ? '1px solid var(--border)' : 'none' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '0.5rem', flexWrap: 'wrap' }}>
            <strong style={{ fontSize: '0.95rem' }}>{associated.cuit}</strong>
            <span style={{ fontSize: '0.75rem', color: 'var(--muted-foreground)' }}>Rol: asociado</span>
            {val && (
              <span style={{ fontSize: '0.75rem', display: 'flex', alignItems: 'center', gap: '0.25rem', color: val.status === 'VALID' ? '#10b981' : '#ef4444' }}>
                {val.status === 'VALID' ? <Check size={12} /> : <AlertTriangle size={12} />}
                {val.status === 'VALID' ? 'CUIT válido' : 'CUIT inválido'}
              </span>
            )}
          </div>
          {associated.evidence && (
            <div style={{ fontSize: '0.8rem', color: 'var(--muted-foreground)', marginTop: '0.25rem' }}>
              Evidencia: <b>{associated.evidence}</b>
            </div>
          )}
          {associated.bcra && Object.values(associated.bcra.estados || {}).some((status: any) => status !== 'no_consultado') && (
            <div style={{ marginTop: '0.75rem' }}>
              <div style={{ fontSize: '0.75rem', fontWeight: 600, color: 'var(--muted-foreground)', marginBottom: '0.35rem' }}>
                Verificación BCRA (CUIT asociado {index + 1})
              </div>
              <BcraPanel verification={associated.bcra} />
            </div>
          )}
        </div>
      );
    })}
  </div>
)}<QuotePanel data={data} quote={quote} onQuote={onQuote} /><div className="data-card-footer"><p><Pencil size={14} /> Podés editar este cheque. Las validaciones se recalculan automáticamente.</p><Button className="primary-button" onClick={onConfirm} disabled={Boolean(confirmed)}><Check size={17} /> {confirmed ? `Registrado · ${confirmed.id}` : 'Confirmar cheque'}</Button></div></Card>;
}

export default function Home() {
  const inputRef = useRef<HTMLInputElement>(null);
  const [step, setStep] = useState<Step>('upload');
  const [file, setFile] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [analysis, setAnalysis] = useState<AnalysisResponse | null>(null);
  const [editedFieldsByCheque, setEditedFieldsByCheque] = useState<Record<number, FieldName[]>>({});
  const [showOcr, setShowOcr] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const [error, setError] = useState('');
  const [confirmed, setConfirmed] = useState<ConfirmedCheque | null>(null);
  const [confirmedByCheque, setConfirmedByCheque] = useState<Record<number, ConfirmedCheque>>({});
  const [quoteByCheque, setQuoteByCheque] = useState<Record<number, QuoteResponse | undefined>>({});
  const [progressIndex, setProgressIndex] = useState(0);
  const [evaluationEnabled, setEvaluationEnabled] = useState(false);
  const [groundTruth, setGroundTruth] = useState<GroundTruth>(emptyGroundTruth);
  const [evaluationResult, setEvaluationResult] = useState<EvaluationResult | null>(null);
  const [evaluationStats, setEvaluationStats] = useState<EvaluationStats | null>(null);
  const [evaluationSubmitting, setEvaluationSubmitting] = useState(false);
  const [activeChequeId, setActiveChequeId] = useState(1);

  const cheques = useMemo(() => analysis ? (analysis.cheques?.length ? analysis.cheques : [analysis.data]).map(identityFor) : [], [analysis]);
  const activeData = cheques.find((item) => item.id === activeChequeId) || cheques[0];
  const visibleConfidence = activeData ? (activeData.finalConfidence || activeData.confidence) : {} as ConfidenceMap;
  const quality = Object.values(visibleConfidence).length ? Math.round(Object.values(visibleConfidence).reduce((a, b) => a + b, 0) / Object.values(visibleConfidence).length * 100) : 0;

  useEffect(() => {
    fetch('/api/healthz').then((response) => response.json()).then((payload) => { setEvaluationEnabled(payload.evaluationMode === true); if (payload.evaluationMode === true) fetch('/api/evaluation/stats').then((response) => response.ok ? response.json() : null).then((statsPayload) => statsPayload?.stats && setEvaluationStats(statsPayload.stats)).catch(() => undefined); }).catch(() => undefined);
  }, []);

  function acceptFile(candidate: File | undefined) { if (!candidate) return; setError(''); const validType = ['image/jpeg', 'image/png', 'image/webp'].includes(candidate.type); const validExtension = ['.jpg', '.jpeg', '.png', '.webp'].includes(getFileExtension(candidate)); if (!validType || !validExtension) { setError('Elegí una imagen JPG, PNG o WEBP.'); return; } if (candidate.size > 10 * 1024 * 1024) { setError('La imagen supera el límite de 10 MB.'); return; } if (previewUrl) URL.revokeObjectURL(previewUrl); setFile(candidate); setPreviewUrl(URL.createObjectURL(candidate)); setAnalysis(null); setConfirmed(null); setConfirmedByCheque({}); setQuoteByCheque({}); setEditedFieldsByCheque({}); setStep('preview'); }
  function onFileChange(event: ChangeEvent<HTMLInputElement>) { acceptFile(event.target.files?.[0]); }
  function onDrop(event: DragEvent<HTMLDivElement>) { event.preventDefault(); setIsDragging(false); acceptFile(event.dataTransfer.files?.[0]); }

  async function analyzeCheque() { if (!file) return; setError(''); setStep('processing'); setProgressIndex(0); const timer = window.setInterval(() => setProgressIndex((index) => Math.min(index + 1, 4)), 650); try { const formData = new FormData(); formData.append('image', file); const response = await fetch('/api/extract-cheque', { method: 'POST', body: formData }); const payload = await response.json(); if (!response.ok) throw new Error(payload.error || 'No pudimos analizar el cheque.'); setAnalysis(payload); setActiveChequeId(payload.cheques?.[0]?.id || 1); setQuoteByCheque({}); setEditedFieldsByCheque({}); setEvaluationResult(null); setGroundTruth(emptyGroundTruth); setShowOcr(false); setStep('results'); } catch (requestError) { setError(requestError instanceof Error ? requestError.message : 'No pudimos analizar el cheque.'); setStep('preview'); } finally { window.clearInterval(timer); } }

  async function requestQuote(data: ExtractedData) { const id = data.id || 1; setQuoteByCheque((current) => ({ ...current, [id]: { status: 'loading' } })); try { const response = await fetch('/api/quote', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ amount: data.importe, dueDate: data.fecha_pago }) }); const payload = await response.json(); if (!response.ok) throw new Error(payload.error || 'No se pudo calcular la cotización.'); setQuoteByCheque((current) => ({ ...current, [id]: payload })); } catch (requestError) { setQuoteByCheque((current) => ({ ...current, [id]: { status: 'incomplete', message: requestError instanceof Error ? requestError.message : 'No se pudo calcular la cotización.' } })); } }

  async function submitEvaluation() { if (!activeData || !evaluationEnabled) return; setEvaluationSubmitting(true); setError(''); try { const response = await fetch('/api/evaluation', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ data: activeData, groundTruth: { ...groundTruth, importe: groundTruth.importe || null } }) }); const payload = await response.json(); if (!response.ok) throw new Error(payload.error || 'No se pudo evaluar el cheque.'); setEvaluationResult(payload); setEvaluationStats(payload.stats); } catch (requestError) { setError(requestError instanceof Error ? requestError.message : 'No se pudo evaluar el cheque.'); } finally { setEvaluationSubmitting(false); } }

  function updateField(id: number, field: FieldName, rawValue: string) { if (!analysis) return; const current = (analysis.cheques?.length ? analysis.cheques : [analysis.data]).map(identityFor); const nextList = current.map((item) => { if (item.id !== id) return item; const next: ExtractedData = { ...item, confidence: { ...item.confidence } }; if (field === 'importe') next.importe = normalizeAmountLocal(rawValue); else if (field === 'fecha_pago') next.fecha_pago = normalizeDateLocal(rawValue); else if (field === 'cheque_numero') next.cheque_numero = rawValue.replace(/\D/g, ''); else next[field] = rawValue || null; next.finalConfidence = { ...next.confidence, [field]: 0.99 }; if (field === 'cuit' && next.validation) { const cuitValidation = validateCuit(next.cuit); next.validation = { ...next.validation, cuit: cuitValidation }; next.cuit_validation = cuitValidation; } if (field === 'importe' && next.validation) next.validation = { ...next.validation, importe: { ...next.validation.importe, value: next.importe, message: next.importe !== null ? 'Importe válido' : 'Importe inválido' } }; if (field === 'fecha_pago' && next.validation) next.validation = { ...next.validation, fecha_pago: { ...next.validation.fecha_pago, value: next.fecha_pago, message: next.fecha_pago ? 'Fecha válida' : 'Fecha inválida' } }; if (field === 'cheque_numero' && next.validation) next.validation = { ...next.validation, cheque_numero: { ...next.validation.cheque_numero, value: next.cheque_numero, confidence: next.cheque_numero ? 0.99 : 0.2, message: next.cheque_numero ? 'Número de cheque detectado' : 'Número de cheque no detectado' } }; return next; }); const first = nextList[0]; setAnalysis({ ...analysis, data: first, cheques: nextList }); setQuoteByCheque((current) => ({ ...current, [id]: undefined })); setEditedFieldsByCheque((currentFields) => ({ ...currentFields, [id]: currentFields[id]?.includes(field) ? currentFields[id] : [...(currentFields[id] || []), field] })); }

  async function confirmCheque(item: ExtractedData) { setError(''); try { const response = await fetch('/api/cheques', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ imageUrl: previewUrl, ...item, cheque_numero: item.cheque_numero, fecha_pago: item.fecha_pago, ocrText: analysis?.ocrText || '', extractionMode: analysis?.mode, editedFields: editedFieldsByCheque[item.id || 1] || [], confidence: item.finalConfidence || item.confidence }) }); const payload = await response.json(); if (!response.ok) throw new Error(payload.error || 'No pudimos registrar el cheque.'); const id = item.id || 1; setConfirmedByCheque((current) => ({ ...current, [id]: payload })); if (cheques.length === 1) { setConfirmed(payload); setStep('confirmed'); } } catch (requestError) { setError(requestError instanceof Error ? requestError.message : 'No pudimos registrar el cheque.'); } }

  function reset() { if (previewUrl) URL.revokeObjectURL(previewUrl); setFile(null); setPreviewUrl(null); setAnalysis(null); setConfirmed(null); setConfirmedByCheque({}); setQuoteByCheque({}); setEditedFieldsByCheque({}); setError(''); setStep('upload'); }
  const pipelineLabel = analysis?.mode === 'mock' ? 'Modo laboratorio' : analysis?.mode === 'ocr_gemini' ? 'OCR + Gemini' : 'Gemini Vision';

  return <main className="app-shell"><div className="ambient-glow ambient-glow-one" /><div className="ambient-glow ambient-glow-two" /><header className="site-header"><div className="brand-lockup"><div className="brand-mark"><span>CC</span></div><div><div className="brand-name">CHEQUE<span>CLARO</span></div><div className="brand-tagline">Inteligencia documental argentina</div></div></div><div className="header-status"><span className="status-dot" /> procesamiento seguro</div></header>
    <section className="content-wrap">
      {step === 'upload' && <div className="hero-grid enter-animation"><div className="hero-copy"><Badge className="eyebrow"><Sparkles size={13} /> extracción inteligente</Badge><h1>De la foto al dato,<br /><em>en un instante.</em></h1><p className="hero-description">Extraé los datos principales de tus cheques argentinos con una lectura clara, rápida y trazable.</p><div className="proof-row"><span><ShieldCheck size={16} /> Datos estructurados</span><span><Check size={16} /> Validación local</span></div></div><div className="upload-card"><div className={cn('dropzone', isDragging && 'dropzone-active')} onDragOver={(event) => { event.preventDefault(); setIsDragging(true); }} onDragLeave={() => setIsDragging(false)} onDrop={onDrop} onClick={() => inputRef.current?.click()} role="button" tabIndex={0} onKeyDown={(event) => event.key === 'Enter' && inputRef.current?.click()}><input ref={inputRef} type="file" accept="image/jpeg,image/png,image/webp" capture="environment" onChange={onFileChange} hidden /><div className="drop-icon"><Upload size={23} /></div><h2>Arrastrá una imagen aquí</h2><p>o seleccioná un archivo desde tu dispositivo</p><Button type="button" className="primary-button" onClick={(event) => { event.stopPropagation(); inputRef.current?.click(); }}><FileImage size={17} /> Seleccionar foto</Button><div className="scan-strip"><span>CUIT</span><i>··········</i><span>IMPORTE</span><i>··········</i><span>FECHA</span></div><div className="file-hint">JPG · PNG · WEBP <span>·</span> hasta 10 MB</div></div><button type="button" className="camera-button" onClick={() => inputRef.current?.click()}><Camera size={18} /> Sacar / seleccionar foto</button></div></div>}
      {step === 'preview' && previewUrl && <div className="workflow-page enter-animation"><WorkflowHeader current="preview" onReset={reset} /><div className="preview-layout"><Card className="preview-card"><div className="card-kicker"><FileImage size={16} /> vista previa</div><div className="image-frame"><img src={previewUrl} alt="Vista previa del cheque seleccionado" /></div><div className="preview-meta"><div><strong>{file?.name}</strong><span>{file ? `${(file.size / 1024 / 1024).toFixed(2)} MB` : ''}</span></div><button type="button" onClick={reset}><RotateCcw size={15} /> cambiar foto</button></div></Card><div className="action-panel"><div className="section-label">listo para analizar</div><h1>Revisá tu imagen<br /><em>antes de empezar.</em></h1><p>La foto original se preserva sin modificaciones. Primero preparamos una copia optimizada para la lectura.</p><Button className="primary-button wide-button" onClick={analyzeCheque}><WandSparkles size={18} /> Analizar cheque</Button><div className="privacy-note"><ShieldCheck size={16} /><span>Procesamiento protegido<br /><b>La API key nunca llega al navegador.</b></span></div></div></div></div>}
      {step === 'processing' && <div className="processing-page enter-animation"><div className="processing-orbit"><div className="orbit-center"><FileImage size={28} /></div><div className="orbit-ring" /></div><Badge className="eyebrow">procesando documento</Badge><h1>Estamos leyendo<br /><em>cada detalle.</em></h1><p>Gemini Vision separa cada cheque antes de interpretar sus campos.</p><div className="progress-list">{['Imagen recibida', 'Imagen preparada', 'Detectando cheques', 'Interpretando datos', 'Validando información', 'Verificando BCRA'].map((label, index) => <div className={cn('progress-item', index < progressIndex ? 'done' : index === progressIndex ? 'active' : '')} key={label}><span className="progress-icon">{index < progressIndex ? <Check size={14} /> : index === progressIndex ? <Loader2 size={14} className="spin" /> : <span />}</span>{label}</div>)}</div></div>}
      {step === 'results' && analysis && activeData && <div className="workflow-page results-page enter-animation"><WorkflowHeader current="results" onReset={reset} /><div className="results-intro"><div><div className="section-label">lectura completada · {pipelineLabel}</div><h1>{cheques.length > 1 ? `Se detectaron ${cheques.length} cheques` : <>Datos del <em>cheque.</em></>}</h1></div><div className="result-stamp"><Check size={15} /> análisis listo</div></div>{cheques.length > 1 && <div className="multi-cheque-notice"><ShieldCheck size={16} /> Cada tarjeta corresponde a un cheque independiente. Los datos no se combinan entre documentos.</div>}<div className="results-grid"><div className="cheque-cards-column">{cheques.map((item) => <ChequeResultCard key={item.id} data={item} quote={quoteByCheque[item.id || 1]} editedFields={editedFieldsByCheque[item.id || 1] || []} confirmed={confirmedByCheque[item.id || 1]} onUpdate={(field, value) => updateField(item.id || 1, field, value)} onQuote={() => requestQuote(item)} onConfirm={() => confirmCheque(item)} />)}</div><aside className="side-column"><Card className="insight-card"><div className="insight-top"><span className="card-kicker">control de calidad · cheque {activeData.id}</span><span className="score-badge"><Sparkles size={13} /> {quality}%</span></div><h3>{cheques.length > 1 ? 'Cheque seleccionado' : 'Lectura consistente'}</h3><p>Los campos críticos fueron priorizados y validados localmente antes de mostrarlos.</p><div className="quality-bar"><span style={{ width: `${quality}%` }} /></div><div className="quality-legend"><span><i className="dot-high" /> Alta</span><span><i className="dot-review" /> Revisar</span><span><i className="dot-low" /> Baja</span></div><div className="cheque-selector">{cheques.map((item) => <button type="button" className={cn(activeData.id === item.id && 'active')} key={item.id} onClick={() => { setActiveChequeId(item.id || 1); setEvaluationResult(null); setGroundTruth(emptyGroundTruth); }}>Cheque {item.id}</button>)}</div></Card><Card className="ocr-card"><button type="button" className="collapse-button" onClick={() => setShowOcr(!showOcr)}><span><span className="card-kicker">debug de extracción</span><strong>Ver texto OCR</strong></span>{showOcr ? <ChevronUp size={18} /> : <ChevronDown size={18} />}</button>{showOcr && <Textarea readOnly value={analysis.ocrText || 'No se ejecutó OCR en este modo.'} className="ocr-textarea" />}</Card>{evaluationEnabled && <EvaluationPanel activeData={activeData} groundTruth={groundTruth} setGroundTruth={setGroundTruth} evaluationSubmitting={evaluationSubmitting} submitEvaluation={submitEvaluation} evaluationResult={evaluationResult} evaluationStats={evaluationStats} />}{analysis.comparison && <Card className="comparison-card"><span className="card-kicker">testing</span><h3>Comparación A/B</h3><div className="comparison-table"><div className="comparison-header"><span>Campo</span><span>OCR + Gemini</span><span>Vision</span></div>{(['cuit', 'cheque_numero', 'importe', 'fecha_pago', 'banco', 'librador'] as FieldName[]).map((field) => <div className="comparison-row" key={field}><span>{fieldLabels[field]}</span><span>{getPreviewField(analysis.comparison!.ocrGemini, field)}</span><span>{getPreviewField(analysis.comparison!.geminiVision, field)}</span></div>)}</div></Card>}</aside></div></div>}
      {step === 'confirmed' && confirmed && <div className="confirmed-page enter-animation"><div className="success-seal"><Check size={30} /></div><Badge className="eyebrow">registro confirmado</Badge><h1>Cheque <em>registrado.</em></h1><p>Los datos quedaron guardados en el repositorio de laboratorio.</p><Card className="confirmation-card"><div className="confirmation-id"><span>ID DE REGISTRO</span><strong>{confirmed.id}</strong></div><Separator /><div className="confirmation-summary"><div><span>CUIT</span><strong>{confirmed.cuit || '—'}</strong></div><div><span>CHEQUE</span><strong>{confirmed.chequeNumero || '—'}</strong></div><div><span>IMPORTE</span><strong>{formatARS(confirmed.importe)}</strong></div><div><span>FECHA</span><strong>{displayDate(confirmed.fechaPago)}</strong></div></div></Card><Button className="secondary-button" onClick={reset}><RotateCcw size={17} /> Analizar un nuevo cheque</Button></div>}
      {error && <div className="error-banner" role="alert"><span>{error}</span><button onClick={() => setError('')} aria-label="Cerrar mensaje">×</button></div>}
    </section><footer className="site-footer"><span>ChequeClaro <i>·</i> MVP de laboratorio</span><span>OCR open-source <i>·</i> Gemini configurable</span></footer></main>;
}

function EvaluationPanel({ activeData, groundTruth, setGroundTruth, evaluationSubmitting, submitEvaluation, evaluationResult, evaluationStats }: { activeData: ExtractedData; groundTruth: GroundTruth; setGroundTruth: (value: GroundTruth) => void; evaluationSubmitting: boolean; submitEvaluation: () => void; evaluationResult: EvaluationResult | null; evaluationStats: EvaluationStats | null }) { return <Card className="evaluation-card"><div className="evaluation-card-top"><span className="card-kicker">modo evaluación · cheque {activeData.id}</span><span className="evaluation-live">EVALUATION_MODE=true</span></div><h3>Medí la precisión de Vision</h3><p>Ingresá el valor real del cheque seleccionado para comparar Gemini contra la referencia humana.</p><div className="evaluation-fields">{evaluationFields.map((field) => <div className="evaluation-field" key={field}><Label>{fieldLabels[field]}</Label><Input value={groundTruth[field]} onChange={(event) => setGroundTruth({ ...groundTruth, [field]: event.target.value })} placeholder={field === 'fecha_pago' ? 'DD/MM/AAAA o AAAA-MM-DD' : field === 'importe' ? '$ 2.500.000' : 'Valor real'} inputMode={field === 'importe' ? 'decimal' : field === 'cheque_numero' ? 'numeric' : undefined} /></div>)}</div><Button className="secondary-button evaluation-submit" onClick={submitEvaluation} disabled={evaluationSubmitting || evaluationFields.some((field) => !groundTruth[field])}>{evaluationSubmitting ? <Loader2 size={17} className="spin" /> : <Check size={17} />} {evaluationSubmitting ? 'Comparando…' : 'Comparar con valor real'}</Button>{evaluationResult && <div className="evaluation-result"><div className="card-kicker">resultado {evaluationResult.id}</div>{evaluationFields.map((field) => { const item = evaluationResult.fields[field]; const shownGemini = field === 'importe' ? formatARS(Number(item.geminiValue)) : field === 'fecha_pago' ? displayDate(String(item.geminiValue || '')) : item.geminiValue || 'No detectado'; const shownReal = field === 'importe' ? formatARS(Number(item.realValue)) : field === 'fecha_pago' ? displayDate(String(item.realValue || '')) : item.realValue || 'No informado'; return <div className="evaluation-row" key={field}><div><strong>{fieldLabels[field]}</strong><span>Gemini: {shownGemini} · Real: {shownReal}</span><span>Evidencia: {item.evidence || 'No informada'}</span></div><b className={item.correct ? 'evaluation-correct' : 'evaluation-incorrect'}>{item.correct ? '✓ Correcto' : '✗ Incorrecto'}</b></div>; })}</div>}{evaluationStats && <div className="evaluation-stats"><div className="card-kicker">métricas acumuladas</div><div className="stats-grid"><span>Cheques procesados<strong>{evaluationStats.processedCheques}</strong></span><span>CUIT<strong>{Math.round(evaluationStats.precision.cuit * 100)}%</strong></span><span>N° cheque<strong>{Math.round(evaluationStats.precision.cheque_numero * 100)}%</strong></span><span>Importe<strong>{Math.round(evaluationStats.precision.importe * 100)}%</strong></span><span>Fecha<strong>{Math.round(evaluationStats.precision.fecha_pago * 100)}%</strong></span><span>Correcciones<strong>{evaluationStats.corrections}</strong></span><span>Intervención humana<strong>{Math.round(evaluationStats.humanInterventionRate * 100)}%</strong></span></div></div>}</Card>; }

function WorkflowHeader({ current, onReset }: { current: 'preview' | 'results'; onReset: () => void }) { const steps = [{ key: 'preview', label: 'Foto' }, { key: 'results', label: 'Datos' }, { key: 'confirmed', label: 'Confirmado' }]; return <div className="workflow-header"><div className="stepper">{steps.map((item, index) => <div className={cn('step', steps.findIndex((step) => step.key === current) >= index && 'step-active')} key={item.key}><span>{steps.findIndex((step) => step.key === current) > index ? <Check size={12} /> : index + 1}</span>{item.label}{index < steps.length - 1 && <i />}</div>)}</div><button type="button" className="reset-link" onClick={onReset}><RotateCcw size={14} /> empezar de nuevo</button></div>; }

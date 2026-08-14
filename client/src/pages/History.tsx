import React, { useState } from 'react';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Select, SelectItem, SelectValue, SelectTrigger, SelectContent } from '@/components/ui/select';
import { Search, Calendar, ShieldAlert, CheckCircle2, AlertTriangle, FileText, ArrowLeft, RefreshCw, Pencil, Save, X } from 'lucide-react';

interface ChequeHistoryItem {
  id: string;
  timestamp: number;
  cuit: string | null;
  cuitValidation: 'VALID' | 'INVALID' | 'UNKNOWN';
  chequeNumero: string | null;
  banco: string | null;
  importe: number | null;
  moneda: string;
  fechaPago: string | null;
  librador: string | null;
  status?: string;
  bcra?: any;
  quote?: any;
  editedFields?: string[];
}

type EditableValues = {
  cuit: string;
  chequeNumero: string;
  banco: string;
  importe: string;
  fechaPago: string;
  librador: string;
};

function valuesFromCheque(cheque: ChequeHistoryItem): EditableValues {
  return {
    cuit: cheque.cuit || '',
    chequeNumero: cheque.chequeNumero || '',
    banco: cheque.banco || '',
    importe: cheque.importe === null || cheque.importe === undefined ? '' : String(cheque.importe),
    fechaPago: cheque.fechaPago || '',
    librador: cheque.librador || '',
  };
}

function parseAmount(value: string): number | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const normalized = trimmed.includes(',')
    ? trimmed.replace(/\./g, '').replace(',', '.')
    : trimmed.replace(/\.(?=\d{3}(?:\D|$))/g, '');
  const amount = Number(normalized);
  return Number.isFinite(amount) ? amount : null;
}

export default function HistoryPage() {
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('all');
  const [selectedCheque, setSelectedCheque] = useState<ChequeHistoryItem | null>(null);
  const [loading, setLoading] = useState(false);
  const [cheques, setCheques] = useState<ChequeHistoryItem[]>([]);
  const [editing, setEditing] = useState(false);
  const [savingCorrection, setSavingCorrection] = useState(false);
  const [editValues, setEditValues] = useState<EditableValues | null>(null);
  const [editError, setEditError] = useState('');

  const fetchCheques = async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (search.trim()) params.append('search', search.trim());
      if (statusFilter !== 'all') params.append('status', statusFilter);
      const res = await fetch(`/api/cheques?${params.toString()}`);
      if (res.ok) {
        const data = await res.json();
        setCheques(data);
      }
    } catch (err) {
      console.error('Error fetching history:', err);
    } finally {
      setLoading(false);
    }
  };

  React.useEffect(() => {
    fetchCheques();
  }, [statusFilter]);

  const handleSearchSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    fetchCheques();
  };

  const startEditing = () => {
    if (!selectedCheque) return;
    setEditValues(valuesFromCheque(selectedCheque));
    setEditError('');
    setEditing(true);
  };

  const cancelEditing = () => {
    setEditing(false);
    setEditValues(null);
    setEditError('');
  };

  const updateEditValue = (field: keyof EditableValues, value: string) => {
    setEditValues((current) => current ? { ...current, [field]: value } : current);
  };

  const saveCorrection = async () => {
    if (!selectedCheque || !editValues) return;
    const importe = parseAmount(editValues.importe);
    if (editValues.importe.trim() && importe === null) {
      setEditError('El importe corregido no tiene un formato numérico válido.');
      return;
    }

    setSavingCorrection(true);
    setEditError('');
    try {
        const nextValues = {
        cuit: editValues.cuit.trim() || null,
        chequeNumero: editValues.chequeNumero.trim() || null,
        banco: editValues.banco.trim() || null,
        importe,
        fechaPago: editValues.fechaPago.trim() || null,
        librador: editValues.librador.trim() || null,
      };
      const changedFields = (Object.keys(nextValues) as Array<keyof typeof nextValues>).filter((field) => nextValues[field] !== selectedCheque[field]);
      const updates = {
        ...nextValues,
        editedFields: Array.from(new Set([...(selectedCheque.editedFields || []), ...changedFields])),
      };
      const response = await fetch(`/api/cheques/${encodeURIComponent(selectedCheque.id)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(updates),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || 'No se pudo guardar la corrección.');
      setSelectedCheque(payload);
      setEditing(false);
      setEditValues(null);
      await fetchCheques();
    } catch (error) {
      setEditError(error instanceof Error ? error.message : 'No se pudo guardar la corrección.');
    } finally {
      setSavingCorrection(false);
    }
  };

  const renderEditField = (label: string, field: keyof EditableValues, type = 'text') => (
    <label className="space-y-1 text-sm" key={field}>
      <span className="text-slate-400">{label}</span>
      <Input
        type={type}
        value={editValues?.[field] || ''}
        onChange={(event) => updateEditValue(field, event.target.value)}
        className="bg-slate-950 border-slate-700 text-white"
      />
    </label>
  );

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 p-4 md:p-8">
      <div className="max-w-6xl mx-auto space-y-6">
        <div className="flex items-center justify-between border-b border-slate-800 pb-4">
          <div className="flex items-center gap-3">
            <Button variant="ghost" size="sm" onClick={() => window.location.href = '/'} className="text-slate-400 hover:text-white">
              <ArrowLeft className="w-4 h-4 mr-1" /> Volver al Inicio
            </Button>
            <h1 className="text-2xl font-bold tracking-tight text-white flex items-center gap-2">
              <FileText className="w-6 h-6 text-indigo-400" /> Historial de Cheques
            </h1>
          </div>
          <Button variant="outline" size="sm" onClick={fetchCheques} className="border-slate-700 bg-slate-900 text-slate-200">
            <RefreshCw className={`w-4 h-4 mr-2 ${loading ? 'animate-spin' : ''}`} /> Actualizar
          </Button>
        </div>

        {selectedCheque ? (
          <Card className="bg-slate-900 border-slate-800">
            <CardHeader className="flex flex-row items-center justify-between border-b border-slate-800">
              <CardTitle className="text-lg text-white">Detalle del Cheque: {selectedCheque.id}</CardTitle>
              <div className="flex items-center gap-2">
                {!editing && <Button variant="outline" size="sm" onClick={startEditing} className="border-indigo-700 text-indigo-200"><Pencil className="w-4 h-4 mr-1" /> Editar datos</Button>}
                <Button variant="outline" size="sm" onClick={() => { cancelEditing(); setSelectedCheque(null); }} className="border-slate-700 text-slate-200">
                  Volver al listado
                </Button>
              </div>
            </CardHeader>
            <CardContent className="p-6 space-y-6">
              {editing && editValues ? (
                <div className="space-y-4">
                  <div className="rounded-lg border border-indigo-900 bg-indigo-950/30 p-4">
                    <div className="flex items-center gap-2 text-indigo-200 font-semibold"><Pencil className="w-4 h-4" /> Corrección manual</div>
                    <p className="text-xs text-slate-400 mt-1">El valor anterior se conservará en la auditoría de correcciones.</p>
                  </div>
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    {renderEditField('CUIT', 'cuit')}
                    {renderEditField('Número de cheque', 'chequeNumero')}
                    {renderEditField('Banco', 'banco')}
                    {renderEditField('Importe', 'importe', 'text')}
                    {renderEditField('Fecha de pago', 'fechaPago', 'date')}
                    {renderEditField('Librador', 'librador')}
                  </div>
                  {editError && <p className="text-sm text-rose-300">{editError}</p>}
                  <div className="flex flex-wrap gap-2">
                    <Button onClick={saveCorrection} disabled={savingCorrection} className="bg-indigo-600 hover:bg-indigo-500 text-white"><Save className="w-4 h-4 mr-1" /> {savingCorrection ? 'Guardando…' : 'Guardar corrección'}</Button>
                    <Button variant="outline" onClick={cancelEditing} disabled={savingCorrection} className="border-slate-700 text-slate-200"><X className="w-4 h-4 mr-1" /> Cancelar</Button>
                  </div>
                </div>
              ) : (
                <>
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-sm">
                    <div className="bg-slate-950 p-4 rounded-lg border border-slate-800 space-y-2">
                      <h3 className="font-semibold text-indigo-300">Datos Principales</h3>
                      <p><span className="text-slate-400">CUIT:</span> {selectedCheque.cuit || 'No detectado'} ({selectedCheque.cuitValidation})</p>
                      <p><span className="text-slate-400">Número:</span> {selectedCheque.chequeNumero || 'No detectado'}</p>
                      <p><span className="text-slate-400">Banco:</span> {selectedCheque.banco || 'No detectado'}</p>
                      <p><span className="text-slate-400">Importe:</span> {selectedCheque.importe !== null && selectedCheque.importe !== undefined ? `${selectedCheque.moneda} $${selectedCheque.importe.toLocaleString('es-AR')}` : 'No detectado'}</p>
                      <p><span className="text-slate-400">Fecha de Pago:</span> {selectedCheque.fechaPago || 'No detectada'}</p>
                      <p><span className="text-slate-400">Librador:</span> {selectedCheque.librador || 'No detectado'}</p>
                      <p><span className="text-slate-400">Procesado:</span> {new Date(selectedCheque.timestamp).toLocaleString()}</p>
                      {selectedCheque.editedFields?.length ? <p className="text-xs text-indigo-300">Campos editados: {selectedCheque.editedFields.join(', ')}</p> : null}
                    </div>

                    <div className="bg-slate-950 p-4 rounded-lg border border-slate-800 space-y-2">
                      <h3 className="font-semibold text-indigo-300">Verificación BCRA</h3>
                      {selectedCheque.bcra ? (
                        <div className="space-y-1 text-xs">
                          <p><span className="text-slate-400">Titular BCRA:</span> {selectedCheque.bcra.titular_bcra || 'N/D'}</p>
                          <p><span className="text-slate-400">Coincidencia:</span> {selectedCheque.bcra.titular_coincide ? 'Sí' : 'No'}</p>
                          <p><span className="text-slate-400">Peor Situación:</span> {selectedCheque.bcra.situacion_crediticia || 'N/D'}</p>
                          <p><span className="text-slate-400">Rechazados:</span> {selectedCheque.bcra.cheques_rechazados?.cantidad || 0}</p>
                          <p><span className="text-slate-400">Denunciado:</span> {selectedCheque.bcra.cheque_denunciado?.denunciado ? 'SÍ (ALERTA)' : 'No'}</p>
                        </div>
                      ) : (
                        <p className="text-slate-500 text-xs">Sin verificación BCRA registrada.</p>
                      )}

                      <h3 className="font-semibold text-indigo-300 pt-3">Cotización</h3>
                      {selectedCheque.quote ? (
                        <div className="space-y-1 text-xs">
                          <p><span className="text-slate-400">Valor a pagar hoy:</span> ${selectedCheque.quote.montoAPagar?.toLocaleString('es-AR')}</p>
                          <p><span className="text-slate-400">Descuento aplicado:</span> {selectedCheque.quote.porcentaje?.toFixed(2)}% (${selectedCheque.quote.descuento?.toLocaleString('es-AR')})</p>
                          <p><span className="text-slate-400">Plazo:</span> {selectedCheque.quote.plazoBase} días</p>
                        </div>
                      ) : (
                        <p className="text-slate-500 text-xs">Sin cotización registrada.</p>
                      )}
                    </div>
                  </div>
                </>
              )}
            </CardContent>
          </Card>
        ) : (
          <div className="space-y-4">
            <form onSubmit={handleSearchSubmit} className="flex flex-col sm:flex-row gap-3">
              <div className="relative flex-1">
                <Search className="absolute left-3 top-3 w-4 h-4 text-slate-500" />
                <Input
                  placeholder="Buscar por CUIT, número de cheque o librador..."
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  className="pl-9 bg-slate-900 border-slate-800 text-white"
                />
              </div>
              <Select value={statusFilter} onValueChange={setStatusFilter}>
                <SelectTrigger className="w-full sm:w-[200px] bg-slate-900 border-slate-800 text-white">
                  <SelectValue placeholder="Filtrar estado" />
                </SelectTrigger>
                <SelectContent className="bg-slate-900 border-slate-800 text-white">
                  <SelectItem value="all">Todos los estados</SelectItem>
                  <SelectItem value="confirmado">Confirmados</SelectItem>
                  <SelectItem value="revisado">Revisados</SelectItem>
                </SelectContent>
              </Select>
              <Button type="submit" className="bg-indigo-600 hover:bg-indigo-500 text-white">
                Buscar
              </Button>
            </form>

            <div className="grid grid-cols-1 gap-3">
              {cheques.length === 0 ? (
                <Card className="bg-slate-900 border-slate-800 p-8 text-center text-slate-400">
                  No se encontraron cheques registrados en el historial.
                </Card>
              ) : (
                cheques.map((item) => (
                  <Card key={item.id} className="bg-slate-900 border-slate-800 hover:border-slate-700 transition-all cursor-pointer" onClick={() => { setSelectedCheque(item); setEditing(false); setEditError(''); }}>
                    <CardContent className="p-4 flex flex-col md:flex-row items-start md:items-center justify-between gap-4">
                      <div className="space-y-1">
                        <div className="flex items-center gap-2">
                          <span className="font-semibold text-white">{item.id}</span>
                          <Badge variant="outline" className="text-xs border-slate-700 text-slate-300">
                            {item.cuit || 'Sin CUIT'}
                          </Badge>
                          {item.cuitValidation === 'VALID' ? (
                            <Badge className="bg-emerald-950 text-emerald-400 border-emerald-800 text-xs">CUIT Válido</Badge>
                          ) : (
                            <Badge className="bg-amber-950 text-amber-400 border-amber-800 text-xs">Revisar CUIT</Badge>
                          )}
                        </div>
                        <p className="text-sm text-slate-300">
                          Librador: <span className="text-white font-medium">{item.librador || 'No identificado'}</span> | Cheque Nº: <span className="text-white font-medium">{item.chequeNumero || 'N/D'}</span>
                        </p>
                        <p className="text-xs text-slate-500">
                          Procesado: {new Date(item.timestamp).toLocaleString()}
                        </p>
                      </div>

                      <div className="flex items-center gap-4 w-full md:w-auto justify-between md:justify-end">
                        <div className="text-right">
                          <div className="text-base font-bold text-white">
                            {item.importe !== null && item.importe !== undefined ? `${item.moneda} $${item.importe.toLocaleString('es-AR')}` : 'Sin importe'}
                          </div>
                          <div className="text-xs text-slate-400">
                            Venc: {item.fechaPago || 'N/D'}
                          </div>
                        </div>
                        <Button size="sm" variant="outline" className="border-slate-700 text-slate-200">
                          Ver Detalle
                        </Button>
                      </div>
                    </CardContent>
                  </Card>
                ))
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

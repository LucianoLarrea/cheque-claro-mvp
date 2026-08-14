import { SupabaseRestChequeRepository } from "./server/dbSupabaseRest.ts";

const repo = new SupabaseRestChequeRepository();
const marker = "PERSISTENCE_TEST";

try {
  console.log("Iniciando INSERT PERSISTENCE_TEST via Supabase REST...");
  const saved = await repo.saveCheque({
    imageUrl: "https://example.com/test.png",
    cuit: "20-12345678-9",
    cuitValidation: "VALID",
    chequeNumero: marker,
    banco: "BANCO TEST",
    importe: 150000,
    moneda: "ARS",
    fechaPago: "2026-12-31",
    librador: "LIBRADOR TEST",
    ocrText: "TEXTO OCR",
    confidence: { cuit: 1, cheque_numero: 1, banco: 1, importe: 1, fecha_pago: 1, librador: 1 },
    extractionMode: "gemini_vision",
    editedFields: [],
    bcra: { status: "ok" },
    quote: { amount: 140000 },
    status: "confirmado",
  });

  console.log("INSERT OK. ID generado:", saved.id);

  const fetched = await repo.getCheque(saved.id);
  if (!fetched || fetched.chequeNumero !== marker) {
    throw new Error("SELECT no pudo recuperar el registro insertado.");
  }

  console.log("SELECT OK. Registro recuperado desde Supabase:", {
    id: fetched.id,
    chequeNumero: fetched.chequeNumero,
    librador: fetched.librador,
  });

  console.log(JSON.stringify({
    supabaseRestConnected: true,
    insert: true,
    select: true,
    idFound: saved.id,
    error: null,
  }));
} catch (error) {
  const msg = error instanceof Error ? error.message : String(error);
  console.error("Error en prueba REST:", msg);
  console.log(JSON.stringify({
    supabaseRestConnected: false,
    insert: false,
    select: false,
    idFound: null,
    error: msg,
  }));
  process.exitCode = 1;
}

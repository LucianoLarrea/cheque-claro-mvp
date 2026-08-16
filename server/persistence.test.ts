import { describe, expect, it } from "vitest";
import { InMemoryChequeRepository } from "./services/chequeRepository";

describe("Cheque Persistence & Repository Tests", () => {
  it("saves and retrieves a cheque record in memory repository", async () => {
    const repo = new InMemoryChequeRepository();
    const saved = await repo.saveCheque({
      imageUrl: "https://example.com/cheque.png",
      cuit: "20-92455045-5",
      cuitValidation: "VALID",
      chequeNumero: "65764032",
      banco: "Banco de la Provincia",
      importe: 2500000,
      moneda: "ARS",
      fechaPago: "2026-09-15",
      librador: "Empresa S.A.",
      ocrText: "65764032 PÁGUESE A...",
      confidence: { cuit: 0.99, cheque_numero: 0.99, banco: 0.95, importe: 0.99, fecha_pago: 0.99, librador: 0.95 },
      extractionMode: "gemini_vision",
      editedFields: [],
      status: "confirmado"
    });

    expect(saved.id).toBeDefined();
    expect(saved.cuit).toBe("20-92455045-5");

    const fetched = await repo.getCheque(saved.id);
    expect(fetched).not.toBeNull();
    expect(fetched?.importe).toBe(2500000);
  });

  it("filters cheques by search query and status in memory repository", async () => {
    const repo = new InMemoryChequeRepository();
    await repo.saveCheque({
      imageUrl: "",
      cuit: "20-12345678-9",
      cuitValidation: "VALID",
      chequeNumero: "00011122",
      banco: "Galicia",
      importe: 100000,
      moneda: "ARS",
      fechaPago: "2026-10-01",
      librador: "Comercial SRL",
      ocrText: "",
      confidence: { cuit: 1, cheque_numero: 1, banco: 1, importe: 1, fecha_pago: 1, librador: 1 },
      extractionMode: "gemini_vision",
      editedFields: [],
      status: "confirmado"
    });

    const results = await repo.listCheques({ search: "Comercial", status: "confirmado" });
    expect(results.length).toBe(1);
    expect(results[0].librador).toBe("Comercial SRL");

    const emptyResults = await repo.listCheques({ search: "Inexistente" });
    expect(emptyResults.length).toBe(0);
  });
});

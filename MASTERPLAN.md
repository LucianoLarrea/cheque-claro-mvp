# CHEQUECLARO — MASTERPLAN

- **Estado:** Vigente
- **Creado:** 2026-08-16
- **Fuente:** consolida `auditoria_chequeclaro.md`, `chequeclaro_especificacion_fase1.md`, `Revision Commit 1.md`, `Commit 2 Matriz de invalidacion.md` (todos en `D:\@Manus\ChequeClaro\`), y verificación directa contra el código real en `D:\@Manus\cheque-claro-mvp` y `D:\@Manus\cheque-claro-android`.
- **ADR relacionado:** `C:\Users\Luciano\@ClaudeProjects\ChequeClaro\adr\ADR-004-Fase1-Saneamiento-y-Matriz-Invalidacion.md`, `C:\Users\Luciano\@ClaudeProjects\ChequeClaro\adr\ADR-005-Fase1B-Wireado-Matriz-Invalidacion.md`

Este documento es el **documento rector del desarrollo futuro de ChequeClaro**. No contiene código de implementación. Reemplaza la ausencia histórica de `MASTERPLAN.md` señalada en `todo.md`/`ADR-002` — `todo.md` sigue siendo la fuente de verdad del historial ya ejecutado (lista plana `[x]`); este documento es la fuente de verdad de lo que falta y por qué.

---

## 1. Objetivo

Desacoplar cuatro responsabilidades que hoy están fusionadas en un único request síncrono (`POST /api/cheques/analyze`):

```text
A. Extracción Gemini (rápida, ~síncrona)
B. Revisión/cotización (rápida, en memoria)
C. Verificación BCRA (lenta, externa, no crítica para persistir el documento)
D. Persistencia (rápida, Supabase REST)
```

sin introducir infraestructura innecesaria (Redis, Kafka, colas, microservicios, WebSockets) salvo que se demuestre que promesas en memoria no alcanzan.

Objetivo secundario, igual de importante: que una corrección manual de datos (`PATCH`) no deje información BCRA obsoleta mostrándose como vigente.

---

## 2. Arquitectura actual (confirmada en código, 2026-08-16)

```text
Android / Web
   │
   │ POST /api/cheques/analyze
   ▼
readImage (multipart/base64)
   ▼
preprocessImage (Sharp)
   ▼
extractionService.extract()
   ├─ Gemini Vision (o OCR+Gemini) — puede devolver N cheques
   ├─ validateAndNormalize() por cheque
   └─ verifyWithBcra() por CUIT, EN PARALELO PERO BLOQUEANTE — sin timeout duro
   ▼
calculateQuote() — en memoria, no bloquea
   ▼
chequeRepository.saveCheque() — SOLO cheques[0], Supabase REST
   ▼
Response { success, origin, extraction, quote, record }
```

Android espera esta respuesta completa con un timeout de 45s (`AbortController`). Si Gemini reintenta por 503 (hasta 2 veces, backoff 600ms/1200ms) y BCRA tarda cerca de su límite de 8s por CUIT, el total puede acercarse o superar ese límite — la causa raíz documentada en la auditoría.

## 3. Arquitectura objetivo

```text
POST /api/cheques/analyze (rápido, sin BCRA en el camino crítico)
  │
  ├─ 1. Sharp
  ├─ 2. Gemini Vision (multi-cheque)
  ├─ 3. Validación interna (módulo 11, normalización)
  ├─ 4. Cotización (en memoria)
  └─ 5. Persistencia (Supabase REST) → devuelve records[] con bcra.state = NOT_STARTED
          │
          └─ (background) → Análisis BCRA por cheque/CUIT
                              │
                              └─ Actualiza BD: bcra.state = RUNNING → COMPLETED | FAILED

GET /api/cheques/:id — polling para hidratar el estado BCRA una vez que termina
```

Principios:
- La extracción/persistencia del documento nunca espera a un tercero no crítico para eso (BCRA).
- Toda corrección manual es fuente de verdad y dispara recalibraciones precisas, no un simple `UPDATE` ciego.
- Todo cheque detectado se persiste individualmente (no solo el primero).

## 4. Diferencias actual vs. objetivo (estado 2026-08-16)

| Área | Estado actual | Estado objetivo | Gap | Prioridad |
|---|---|---|---|---|
| **PATCH — Allowlist** | ✅ Implementada (`allowedKeys`, Commit 1) | Igual | Ninguno | — |
| **Código muerto Postgres/Drizzle** | ✅ Eliminado (`dbPostgres.ts`, `0001_*.sql`, Commit 1) | Igual | Ninguno | — |
| **Matriz de Invalidación** | ✅ Implementada y **conectada** (`determineInvalidation`, wireada en `updateCheque`, `ADR-005`, commit `f87009c`) | Igual | Ninguno | — |
| **BCRA tras PATCH** | ✅ Se invalida (`STALE`) o reinterpreta según la matriz (`ADR-005`) | Igual | Ninguno | — |
| **BCRA en `/analyze`** | Síncrono, bloqueante, sin timeout propio | Asíncrono, no bloquea la respuesta | Motiva el riesgo de timeout de Android | 🔴 CRÍTICO (pero de mayor esfuerzo) |
| **Multi-cheque** | Extrae N, persiste solo `cheques[0]` | Persiste los N cheques detectados | Pérdida silenciosa de datos de cheques 2..N vía `/analyze` (no vía flujo web manual, que sí confirma cada uno) | 🟠 ALTO |
| **Imagen original** | Se descarta tras extraer (`imageUrl` vacío o blob efímero) | Persistida en Storage | Regla de negocio no aplicada — sin evidencia de auditoría | 🟡 MEDIO |
| **Timeout Gemini** | Sin `AbortController` propio en el fetch a Gemini | Límite explícito y manejado | Depende del timeout del cliente/hosting | 🟡 MEDIO |

---

## 5. Estados BCRA propuestos

```text
NOT_STARTED → RUNNING → COMPLETED | FAILED
COMPLETED | FAILED --(cambio de CUIT/Nº/Banco)--> STALE → RUNNING
```

- `NOT_STARTED`: el cheque fue extraído/persistido, la consulta BCRA aún no se lanzó o encoló.
- `RUNNING`: las peticiones HTTP a BCRA están en curso. **El job de background debe persistir este estado antes de iniciar la consulta a BCRA** (no solo al terminar) — da observabilidad real del pipeline y es indispensable para que el polling de Fase 1D distinga "todavía no arrancó" de "está corriendo ahora".
- `COMPLETED`: peticiones concluidas, nivel de riesgo determinado.
- `FAILED`: error de red/timeout/rechazo del lado de BCRA. El cheque persiste válido igual. Incluye el campo `error` (ver más abajo) con el motivo, para debug y para eventual mensaje user-facing en Fase 1D.
- `STALE`: un campo pivotal (CUIT, banco, número) cambió por edición manual, invalidando el resultado anterior — requiere nueva consulta.

Este objeto vive dentro (o como metadato junto a) la columna `bcra_result` ya existente en Supabase.

**Campo `error` (agregado en Fase 1C):** cuando `state = FAILED`, `bcra_result` incluye `"error": string` con una descripción corta y no sensible de la causa (ej. `"timeout"`, `"http_500"`, `"network_error"`) — nunca un stack trace completo ni datos de la request. En cualquier otro estado (`NOT_STARTED`/`RUNNING`/`COMPLETED`/`STALE`), el campo `error` está ausente o `null`. Ejemplo:

```json
{
  "state": "FAILED",
  "snapshot": { "cuit": "20123456789", "cheque_numero": "00012345", "banco": "BANCO GALICIA" },
  "data": null,
  "error": "timeout"
}
```

## 6. Estrategia de consistencia — snapshot

Para que un resultado BCRA viejo nunca quede asociado a un CUIT ya modificado, incluso si falla la lógica de invalidación en algún punto:

```json
"bcra_result": {
  "state": "COMPLETED",
  "snapshot": { "cuit": "20123456789", "cheque_numero": "00012345", "banco": "BANCO GALICIA" },
  "data": { ... }
}
```

Al leer el cheque (frontend o backend), se compara el `cuit`/`chequeNumero`/`banco` actual del registro contra `bcra_result.snapshot`. Si difieren, se trata como `STALE` automáticamente — defensa en profundidad independiente de que la invalidación explícita se haya ejecutado correctamente.

## 7. Matriz de Invalidación — implementada y conectada (Commit 2 + `ADR-005`)

`determineInvalidation(oldCheque, newCheque)` en `server/services/invalidationService.ts` (función pura, sin HTTP/Supabase/BCRA/Express, con tests en `server/invalidationService.test.ts`):

| Campo | `requiresBcraFetch` | `requiresBcraReinterpretation` | `requiresQuoteRecalc` |
|---|:---:|:---:|:---:|
| `cuit` | SÍ | SÍ | NO |
| `chequeNumero` | SÍ | SÍ | NO |
| `banco` | SÍ | SÍ | NO |
| `librador` | NO | SÍ | NO |
| `importe` | NO | NO | SÍ |
| `fechaPago` | NO | NO | SÍ |
| `moneda` | NO | NO | SÍ |

Reutiliza normalización existente (`normalizeCuit`, `normalizeFecha`/`normalizeImporte`/`normalizeNumeroCheque` de `validationService.ts`) para no marcar como "cambiado" un campo que solo cambió de formato.

**Conectada desde Fase 1B (`ADR-005`, commit `f87009c`)** al `PATCH`/`updateCheque` real en `dbSupabaseRest.ts`:
- Si `requiresBcraFetch` → limpia `bcra_result.data`, marca `STALE`, snapshot nuevo. **No dispara la consulta BCRA en background todavía** — eso sigue siendo Fase 1C.
- Si solo `requiresBcraReinterpretation` (ej. cambió solo `librador`) → sin llamada HTTP, reutiliza `bcra_result.data` existente y recalcula `titular_coincide`/`nivel` con `compareBcraTitular()`/`buildBcraRiskLevel()`.
- Si `requiresQuoteRecalc` → invoca `calculateQuote()` antes del `UPDATE` y sobrescribe `quote_result`.
- Además de la matriz base, se agregó una defensa de snapshot ampliada (compara el registro fusionado completo contra `bcra.snapshot`, no solo los campos del PATCH) para cubrir también mismatches preexistentes — ver `ADR-005`.

## 8. Retry BCRA — regla de diseño

Un retry técnico de BCRA (por timeout/error de red, sin que el usuario haya editado nada) **no cambia el snapshot ni requiere reinterpretación** — los datos del cheque no cambiaron, solo falló la consulta. Un cambio de datos relevantes (vía PATCH) sí dispara invalidación según la matriz de la sección 7.

## 9. Concurrencia

Se necesita control optimista con `id` + un identificador de versión de los datos (o directamente el `snapshot` de la sección 6 cumple ese rol) para evitar:

- Lost updates entre dos `PATCH` casi simultáneos.
- Un resultado BCRA que termina tarde y sobrescribe un resultado más reciente (carrera: si `BCRA v1` corre en background y el usuario edita el CUIT antes de que termine, el resultado de `v1` no debe pisar el nuevo estado `STALE`/`v2`).

**Regla:** el snapshot de la sección 6 es la defensa mínima aceptable — al persistir un resultado BCRA en background, comparar contra el `cuit`/`chequeNumero`/`banco` vigente en ese momento; si no coincide, descartar el resultado en lugar de persistirlo.

## 10. Comunicación con Android/Web tras el desacople

```text
POST /api/cheques/analyze  (rápido, sin esperar BCRA)
        ↓
GET /api/cheques/:id  (polling, cada pocos segundos, hasta ver COMPLETED/FAILED)
```

**No implementar en esta fase:** WebSocket, SSE, Redis, RabbitMQ, Kafka, BullMQ. Razón: el volumen actual (un usuario, procesamiento personal, no multi-tenant) no justifica infraestructura de mensajería — un polling simple cada 2-3s cubre la necesidad de UX sin componentes nuevos que mantener. Reevaluar solo si el volumen de uso cambia sustancialmente.

## 11. Estados de UX propuestos

```text
Analizando cheque...
Datos detectados
Verificando en BCRA...
Actualizando verificación BCRA...
Verificación BCRA completa
Error de verificación BCRA — [Reintentar]
```

## 12. Multi-cheque

**No se implementa en la primera fase del desacople.** Queda como fase futura independiente, para no contaminar el trabajo de invalidación/BCRA con cambios de contrato API + UI de Android (que hoy no tiene carrusel ni lista, solo muestra un cheque en duro).

Estado actual, sin cambios por ahora: Gemini puede detectar múltiples cheques; `/analyze` persiste y devuelve solo el primero (`cheques[0]`); el flujo web manual (`Home.tsx` → `POST /api/cheques` por cheque) sí permite confirmar todos, uno por uno — ahí no hay pérdida de datos.

Cuando se aborde: `/analyze` pasaría a devolver `records: ChequeRecord[]` en vez de `record: ChequeRecord`, con inserciones individuales en Supabase, tolerando fallos parciales (si un cheque del lote falla validación crítica, los demás se persisten igual).

---

## 13. Fases de implementación

### FASE 0 — Auditoría y documentación
**Estado: ✅ Completa.** Este documento, `auditoria_chequeclaro.md`, `ADR-002/003/004`, READMEs de ambos repos.

### FASE 1A — Saneamiento y seguridad
**Estado: ✅ Completa (Commit `3535502`).**
- Allowlist en `PATCH /api/cheques/:id`.
- Eliminación de `dbPostgres.ts` y `drizzle/0001_cheques_persistence.sql`.
- Tests saneados (`vi.stubEnv`, sin dependencia de `.env` real, sin red real). 55/55 verdes.

### FASE 1A-bis — Motor de Matriz de Invalidación
**Estado: ✅ Completa (Commit "feat: add cheque update invalidation matrix").**
- `determineInvalidation(oldCheque, newCheque)` implementada como función pura, testeada.
- **No conectada todavía** a ningún flujo productivo — ver Fase 1B.

### FASE 1B — Wireado de la Matriz + estado/snapshot BCRA
**Estado: ✅ Completa (commit `f87009c` — "feat: wire invalidation matrix + bcra state/snapshot (fase 1B)").**
- `state`/`snapshot` incorporados a `bcra_result` (sección 5 y 6) en `saveCheque()`.
- `determineInvalidation()` conectado a `updateCheque()`: limpieza (`STALE`), reinterpretación (`compareBcraTitular`+`buildBcraRiskLevel`) y recálculo de cotización (`calculateQuote`) según la matriz, todo en el PATCH único existente.
- Defensa de snapshot ampliada: detecta tanto ediciones activas de cuit/número/banco como mismatch preexistente sin editar esos campos (ver `ADR-005`).
- 5 tests nuevos en `server/invalidationWiring.test.ts`, 79/79 tests verdes, `pnpm run check`/`pnpm run build` sin errores.
- Detalle completo, decisiones de diseño y hallazgos: `ADR-005-Fase1B-Wireado-Matriz-Invalidacion.md`.

### FASE 1C — Desacoplamiento BCRA
**Estado: ✅ Completa (pendiente de commit).**
- `extractionService.extract()` acepta `{ skipBcra: true }`; usado por `/api/cheques/analyze` para no consultar BCRA en el camino síncrono. `/api/extract-cheque` no cambió de conducta (sigue sin el flag).
- Nuevo `applyBcraResult()` en `ChequeRepository`/`SupabaseRestChequeRepository`: persiste `RUNNING` antes de consultar BCRA y `COMPLETED`/`FAILED` al terminar, comparando siempre contra el `cuit`/`chequeNumero`/`banco` VIGENTE del cheque (no contra `bcra.snapshot`) — nunca pasa por `updateCheque()`/`determineInvalidation()` (sección 8).
- `runBcraBackgroundJob()` en `chequeRoutes.ts`: se dispara sin `await` después de `res.status(201).json()`, con `.catch()` explícito además de su propio `try/catch` interno. Reutiliza `verifyWithBcra()` (ahora exportada) para no duplicar lógica multi-CUIT.
- Esquema `bcra_result` extendido con el campo `error` (string) exclusivo de `state: FAILED` (sección 5).
- 7 tests nuevos en `server/bcraBackgroundJob.test.ts` (RUNNING antes de BCRA, COMPLETED con data, FAILED con error, ausencia de error fuera de FAILED, descarte por mismatch de snapshot en cuit y en chequeNumero, cheque inexistente). 86/86 tests verdes, `pnpm run check`/`pnpm run build` sin errores.
- Riesgo aceptado y no resuelto en esta fase: reinicio del proceso Node con un job en vuelo deja el cheque en `NOT_STARTED` permanentemente (sección 18).

### FASE 1D — Polling en Android/Web
**Estado: 🔲 No iniciada.**
- Reducir el timeout de Android (hoy 45s) porque `/analyze` ya no esperará BCRA.
- Implementar `GET /api/cheques/:id` en loop hasta ver `COMPLETED`/`FAILED`.
- Actualizar UI con los estados de la sección 11.

### FASE 2 — Retry BCRA sin incrementar snapshot
**Estado: 🔲 No iniciada.** Ver regla de la sección 8.

### FASE 3 — Tests de concurrencia
**Estado: 🔲 No iniciada.** Cubrir las carreras descritas en la sección 9 (snapshot desactualizado, PATCH simultáneo con BCRA en vuelo).

### FASE 4 — Optimización
**Estado: 🔲 No iniciada.** Solo después de validar todo lo anterior en uso real.

### FASE FUTURA — Multi-cheque
**Estado: 🔲 No iniciada, deliberadamente pospuesta** (sección 12).

### FASE FUTURA — Persistencia de imagen original
**Estado: 🔲 No iniciada.** Deuda técnica de menor prioridad (🟡 MEDIO en la tabla de la sección 4) — implica decidir un bucket de Storage y el ciclo de vida de las imágenes.

---

## 14. Regla fundamental de implementación

**No implementar varias fases simultáneamente.**

```text
FASE → diseño detallado → aprobación → implementación → tests
  → verificación manual → git diff → commit → aprobación de la siguiente fase
```

No avanzar automáticamente a la fase siguiente sin aprobación explícita, incluso si el diseño ya está cerrado en este documento.

## 15. Decisiones pendientes de aprobación (bloquean Fase 1B/1C)

Heredadas de `chequeclaro_especificacion_fase1.md`, todavía sin respuesta:

1. **Entorno de ejecución en background:** ¿el backend corre en un proceso Node persistente (VPS/local con `tsx watch` o equivalente), habilitando promesas en background atadas al event loop sin infraestructura adicional? Si es serverless estricto (funciones que mueren al responder), el desacople de BCRA necesita otra estrategia (cola/worker).
2. **Contrato multi-cheque en Android:** cuando `/analyze` empiece a devolver `records[]`, ¿Android puede seguir mostrando solo `records[0]` mientras el backend persiste todos silenciosamente, para no forzar un rediseño de UI con navegación/carrusel en esta fase?
3. **Alcance de BCRA en background:** ¿se mantiene la consulta BCRA para todos los CUITs detectados (principal + asociados), o se limita al CUIT principal para reducir tráfico mientras se estabiliza el desacople?
4. **Autorización para iniciar Fase 1B:** ¿se aprueba conectar `determineInvalidation()` al flujo real de actualización (limpiar/recalcular `bcra_result`/`quote_result` según la matriz), como próximo commit?

No se avanza a Fase 1B/1C sin resolver estas cuatro preguntas.

## 16. Git — disciplina por fase

Antes de modificar código en cualquier fase:

```bash
git status
git branch
git log -n 5
```

Si aparece "dubious ownership": **no** modificar configuración global automáticamente — informar primero. Working tree debe estar limpio antes de cada fase, o los cambios previos deben quedar documentados explícitamente. Cada fase termina en un commit independiente (ej. `feat: decouple bcra analysis from extraction`, luego por separado `feat: add bcra polling`). No mezclar fases en un mismo commit. No hacer push automático sin confirmación.

## 17. Criterios de aceptación

- **Objetivo principal:** Android/Web pueden mostrar "Datos detectados + Cotización" sin esperar a que BCRA termine.
- **BCRA:** se ejecuta en paralelo al resto del flujo de UX, sin bloquear la respuesta de `/analyze`.
- **Corrección:** si cambia el CUIT vía `PATCH`, el BCRA anterior queda obsoleto (`STALE`) y se dispara uno nuevo — nunca se muestra un nivel de riesgo calculado sobre un CUIT que ya no es el vigente.
- **Carrera:** si `BCRA v1` (asociado a datos viejos) termina después de que el usuario ya editó a `v2`, el resultado final visible sigue siendo el de `v2` — `v1` se descarta por mismatch de snapshot.
- **Retry:** un retry técnico de BCRA nunca dispara una reinterpretación de Gemini ni recalcula cotización.
- **Cotización:** cambios de `importe`/`fechaPago`/`moneda` recalculan inmediatamente, sin tocar BCRA.

## 18. Riesgos

| Riesgo | Origen |
|---|---|
| Reinicio del proceso Node mientras BCRA corre en background — el job en memoria se pierde sin persistir `FAILED` | Fase 1C |
| Errores de Supabase durante la actualización en background del resultado BCRA | Fase 1C |
| Gemini lento o en 503 repetido — sigue afectando el tiempo de `/analyze` aunque BCRA se desacople | Ya existente |
| Condiciones de carrera entre `PATCH` y BCRA en vuelo (mitigado por snapshot, sección 6/9) | Fase 1B/1C |
| Pérdida de jobs en memoria si el entorno no es un proceso persistente (ver decisión pendiente #1) | Fase 1C |
| Problemas de red LAN entre Android y el backend (ya documentados, independientes de este plan) | Existente |
| Polling excesivo desde el cliente si no se define un intervalo/backoff razonable | Fase 1D |
| Edición concurrente de un mismo cheque desde dos clientes | Fase 1B (control optimista, sección 9) |
| Multi-cheque pendiente — pérdida silenciosa de cheques 2..N vía `/analyze` sigue activa hasta la fase futura correspondiente | Existente, sin plan de fecha |

## 19. Decisiones no implementadas (fuera de alcance por ahora)

- Implementación multi-cheque (persistencia de N registros vía `/analyze`).
- Worker persistente o cola de jobs (Redis/BullMQ) — solo si la premisa de la decisión pendiente #1 resulta falsa.
- SSE/WebSocket para reemplazar el polling.
- Persistencia de la imagen original en Storage (bucket, ciclo de vida, costos).
- Optimización de Gemini (timeout propio, cambio de modelo, ajuste de prompt).
- Cambios de timeout en Android más allá de lo estrictamente necesario para reflejar el desacople de BCRA.
- Estrategia de deploy/cloud (el proyecto corre hoy localmente vía `tsx watch` + Expo Go/LAN).

---

## Changelog

### 2026-08-18
- Fase 1C marcada como **completa, pendiente de commit**: BCRA desacoplado del camino síncrono de `/analyze` (`skipBcra`), job de background (`runBcraBackgroundJob` + `applyBcraResult`) que persiste `RUNNING` antes de consultar BCRA y `COMPLETED`/`FAILED` al terminar, con defensa de snapshot contra el estado vigente del cheque. Esquema `bcra_result` extendido con campo `error` en `FAILED`. 7 tests nuevos, 86/86 verdes, `check`/`build` sin errores.

### 2026-08-17
- Fase 1B marcada como **completa** (commit `f87009c`): matriz de invalidación conectada a `updateCheque`, `bcra_result` con `state`/`snapshot`, defensa de snapshot ampliada, 5 tests nuevos. Ver `ADR-005-Fase1B-Wireado-Matriz-Invalidacion.md` para el detalle completo, incluyendo el hallazgo de que `invalidationService.ts` (Commit 2 de `ADR-004`) nunca había quedado efectivamente commiteado a git y se cerró junto con este commit.
- Secciones 4 y 7 actualizadas para reflejar el estado real post-commit.

### 2026-08-16
- Documento creado, consolidando `auditoria_chequeclaro.md`, `chequeclaro_especificacion_fase1.md`, `Revision Commit 1.md` y `Commit 2 Matriz de invalidacion.md`.
- Arquitectura actual documentada y verificada contra código real.
- Arquitectura objetivo definida (extracción rápida + BCRA desacoplado + hidratación progresiva + polling).
- Fase 0, Fase 1A y Fase 1A-bis marcadas como completas (verificado en código, no solo por los informes).
- Fase 1B en adelante: **no iniciada**, pendiente de las 4 decisiones de la sección 15.
- Implementación funcional de las fases pendientes: **NO REALIZADA** en este documento.

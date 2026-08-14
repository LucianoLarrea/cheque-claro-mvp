# ChequeClaro MVP

ChequeClaro es una aplicación web mobile-first para extraer y revisar datos de cheques argentinos a partir de una imagen. El producto separa la fotografía original del procesamiento, conserva los ceros iniciales del número de cheque y presenta cada dato con un nivel de confianza editable.

## Flujo implementado

El flujo principal es deliberadamente manual: la persona carga o toma una fotografía, revisa la vista previa y presiona **Analizar cheque**. El backend valida el formato y el límite de 10 MB, prepara una copia de procesamiento, ejecuta el pipeline configurado, valida los campos y devuelve el resultado. La imagen original nunca se modifica durante el preprocesamiento.

La pantalla de resultados permite editar CUIT, número de cheque, banco, importe, fecha de pago y librador. Al modificar los campos críticos se recalculan las validaciones locales. También incluye el texto OCR raw en una sección colapsable y una comparación A/B opcional entre OCR + Gemini y Gemini Vision.

## Modos del pipeline

El modo se controla exclusivamente desde el backend mediante `EXTRACTION_MODE`:

| Valor | Comportamiento |
| --- | --- |
| `mock` | Devuelve datos de laboratorio sin llamadas externas. Es el valor seguro para desarrollo de UI. |
| `ocr_gemini` | Preprocesa una copia con Sharp, ejecuta Tesseract OCR en español y envía el texto a Gemini Developer API para devolver JSON estructurado. |
| `gemini_vision` | Envía la imagen procesada directamente a Gemini Developer API con un esquema JSON estructurado. |

`COMPARISON_MODE=true` ejecuta ambos caminos configurados para comparación A/B y añade los resultados en la respuesta. `DEBUG_EXTRACTION=true` añade duraciones y confianza original para observabilidad durante desarrollo.

`EVALUATION_MODE=true` habilita la evaluación controlada de Gemini Vision. Después de cada extracción, la interfaz permite ingresar el valor real de CUIT, número de cheque, importe y fecha; el backend compara cada campo, conserva la evidencia textual devuelta por Gemini y acumula precisión, correcciones e intervención humana en memoria. Los datos de evaluación se reinician al reiniciar el proceso.

La clave `GEMINI_API_KEY` sólo se lee en el backend mediante `process.env`. Nunca se expone con el prefijo `VITE_`, nunca se incluye en el bundle del navegador y no se devuelve en ninguna respuesta. `GEMINI_MODEL` permite seleccionar el modelo; para la evaluación actual se utiliza `gemini-3.1-flash-lite`.

## API

| Método | Endpoint | Descripción |
| --- | --- | --- |
| `GET` | `/api/healthz` | Estado mínimo del servicio y modo activo. |
| `POST` | `/api/extract-cheque` | Recibe `multipart/form-data` con el campo `image`; acepta JPG, PNG y WEBP hasta 10 MB. También admite JSON con `imageBase64` para integraciones controladas. |
| `POST` | `/api/cheques` | Confirma el resultado y lo guarda en `InMemoryChequeRepository`. |
| `GET` | `/api/cheques/:id` | Recupera un cheque confirmado por ID. |
| `POST` | `/api/evaluation` | Compara los datos de Gemini contra los valores reales ingresados y devuelve el detalle por campo. Requiere `EVALUATION_MODE=true`. |
| `GET` | `/api/evaluation/stats` | Devuelve las métricas acumuladas de evaluación en memoria. Requiere `EVALUATION_MODE=true`. |

La extracción con Gemini utiliza `responseMimeType: application/json`, esquema de respuesta y hasta dos reintentos automáticos después del primer intento. Si Tesseract no está instalado, el backend devuelve un mensaje descriptivo en español para orientar la configuración.

## Validaciones

El backend calcula el dígito verificador de CUIT mediante módulo 11, normaliza importes argentinos como `2.500.000,50`, normaliza fechas `DD/MM/YYYY` a `YYYY-MM-DD`, conserva los ceros iniciales del número de cheque y calcula una confianza final considerando la confianza del extractor y el estado de validación.

Los IDs confirmados siguen estrictamente el formato incremental `CHK-000001`, `CHK-000002`, etc. El repositorio implementa la interfaz `ChequeRepository`, por lo que puede reemplazarse posteriormente por una implementación persistente sin cambiar la capa de rutas.

## Desarrollo

```bash
pnpm install
pnpm check
pnpm test
pnpm build
```

Para activar la evaluación de Vision, configure desde la gestión segura de secretos del proyecto: `EXTRACTION_MODE=gemini_vision`, `GEMINI_MODEL=gemini-3.1-flash-lite` y `EVALUATION_MODE=true`. Después de analizar cada fotografía, ingrese los cuatro valores reales y presione **Comparar con valor real**. Las métricas se consultan en `GET /api/evaluation/stats` y también aparecen en el panel lateral. No agregue claves a archivos versionados ni al código del cliente.

## Estructura relevante

```text
client/src/pages/Home.tsx              Flujo visual mobile-first completo
client/src/index.css                   Sistema visual, responsive y motion
server/chequeRoutes.ts                 Endpoints REST de extracción y confirmación
server/services/extractionService.ts   Orquestación modular de pipelines
server/services/imageService.ts        Preprocesamiento y preservación original
server/services/ocrService.ts          Tesseract local en idioma español
server/services/geminiService.ts       Gemini Developer API en backend
server/services/validationService.ts   CUIT, fechas, importes y confianza
server/services/chequeRepository.ts    Interfaz y repositorio en memoria
server/services/evaluationService.ts   Comparación y métricas de evaluación en memoria
server/*.test.ts                       Pruebas Vitest
```

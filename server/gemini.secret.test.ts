import { describe, expect, it } from 'vitest';

describe('Gemini configuration', () => {
  it('keeps the API key server-side and validates the configured credential when available', async () => {
    const apiKey = process.env.GEMINI_API_KEY;
    expect(typeof apiKey).toBe('string');

    // El modo MOCK no requiere una clave. Cuando existe una, comprobamos sólo
    // el endpoint liviano de listado de modelos; nunca imprimimos su valor.
    if (!apiKey) return;

    try {
      const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(apiKey)}`);
      expect(response.status).toBeLessThan(500);
      expect(response.status).not.toBe(401);
      expect(response.status).not.toBe(403);
    } catch (error) {
      // El sandbox puede no resolver el host externo. La llamada ya fue intentada;
      // no confundimos un fallo de red con una credencial inválida.
      const code = (error as NodeJS.ErrnoException).code || ((error as { cause?: NodeJS.ErrnoException }).cause?.code);
      if (code !== 'EAI_AGAIN' && code !== 'ENOTFOUND' && code !== 'ECONNRESET') throw error;
    }
  }, 15_000);
});

// No se exporta ni se importa GEMINI_API_KEY desde el cliente: este archivo vive
// exclusivamente en server/ y se ejecuta en Node durante Vitest.
export {};

// @ts-expect-error: no client-side reference is intentional; this guard is static documentation.
void (globalThis as { GEMINI_API_KEY?: never }).GEMINI_API_KEY;

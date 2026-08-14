import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

export interface OCRResult {
  text: string;
  durationMs: number;
  error?: string;
}

export class OCRService {
  /**
   * Ejecuta Tesseract OCR en el sistema con el idioma español ('spa').
   * Si Tesseract CLI o el paquete no están disponibles, lanza un error real en lugar de simular datos.
   */
  async extractText(imagePath: string): Promise<OCRResult> {
    const startTime = Date.now();
    console.log('OCR_STARTED');
    try {
      if (!fs.existsSync(imagePath)) {
        throw new Error('El archivo de imagen no existe en la ruta especificada.');
      }

      const outBase = path.join(os.tmpdir(), `ocr_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`);
      // Ejecutar tesseract localmente: tesseract image outpath -l spa
      await execFileAsync('tesseract', [imagePath, outBase, '-l', 'spa'], { timeout: 30000 });

      const outFilePath = `${outBase}.txt`;
      let text = '';
      if (fs.existsSync(outFilePath)) {
        text = fs.readFileSync(outFilePath, 'utf8');
        try { fs.unlinkSync(outFilePath); } catch {}
      } else {
        throw new Error('Tesseract no generó el archivo de texto esperado.');
      }

      console.log('OCR_COMPLETED');
      return {
        text: text.trim(),
        durationMs: Date.now() - startTime,
      };
    } catch (error: any) {
      console.error('[OCRService] Error en Tesseract OCR:', error);
      throw new Error(`Error en Tesseract OCR: ${error.message || 'No se pudo leer el texto de la imagen.'}`);
    }
  }
}

export const ocrService = new OCRService();

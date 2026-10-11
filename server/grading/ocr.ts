import path from "node:path";
import { createWorker, PSM, type Worker } from "tesseract.js";
import { isReviewConfidence as isReviewConfidenceFor, type OcrScript } from "./types";

const TESSDATA_PATH = path.join(process.cwd(), "server", "grading", "tessdata");

export type OcrText = {
  text: string;
  confidence: number;
  script: OcrScript;
};

function detectScript(answerKey: string): OcrScript {
  const latin = (answerKey.match(/[a-z]/giu) ?? []).length;
  const korean = (answerKey.match(/[\uac00-\ud7a3]/gu) ?? []).length;
  return latin >= korean ? "eng" : "kor";
}

export function selectOcrScript(answerKey: string): OcrScript {
  return detectScript(answerKey);
}

const LATIN_WHITELIST = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";
const DIGIT_WHITELIST = "0123456789";

/**
 * Build the Tesseract character whitelist for a cell.
 *
 * Digits are added only when the answer key itself contains a digit, so a plain
 * word keeps exactly the previous letter-only behaviour (which prevents letters
 * such as "l" from turning into "1") while answers like "word2" are no longer
 * truncated to "word".
 */
export function buildOcrWhitelist(script: OcrScript, answerKey: string) {
  if (script !== "eng") return undefined;
  return /[0-9]/.test(answerKey) ? `${LATIN_WHITELIST}${DIGIT_WHITELIST}` : LATIN_WHITELIST;
}

export class SingleOcrWorker {
  private worker: Worker | null = null;
  private script: OcrScript | null = null;

  async recognize(image: Buffer, answerKey: string): Promise<OcrText> {
    const script = detectScript(answerKey);
    await this.ensureWorker(script);
    if (!this.worker) throw new Error("OCR worker가 준비되지 않았습니다.");

    const whitelist = buildOcrWhitelist(script, answerKey);
    await this.worker.setParameters({
      tessedit_pageseg_mode: PSM.SINGLE_LINE,
      ...(whitelist ? { tessedit_char_whitelist: whitelist } : { tessedit_char_whitelist: "" }),
    });
    const { data } = await this.worker.recognize(image);
    const confidence = Number.isFinite(data.confidence) ? data.confidence : 0;
    return {
      text: data.text.replace(/[\r\n]+/g, " ").replace(/\s+/g, " ").trim(),
      confidence,
      script,
    };
  }

  async close() {
    const worker = this.worker;
    this.worker = null;
    this.script = null;
    if (worker) await worker.terminate();
  }

  isReviewConfidence(confidence: number, script: OcrScript = "eng") {
    return isReviewConfidenceFor(confidence, script);
  }

  private async ensureWorker(script: OcrScript) {
    if (this.worker && this.script === script) return;
    await this.close();
    this.worker = await createWorker(script, 1, {
      langPath: TESSDATA_PATH,
      cachePath: TESSDATA_PATH,
      gzip: false,
    });
    this.script = script;
  }
}

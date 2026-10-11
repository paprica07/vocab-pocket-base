import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import fontkit from "@pdf-lib/fontkit";
import { PDFDocument, StandardFonts } from "pdf-lib";
import type { QuestionDirection, PdfQuestion, WorksheetManifest } from "../../lib/worksheet-layout";
import { worksheetPdfMarker } from "../../lib/worksheet-layout";

const ROOT = process.cwd();
const FONT_PATH = path.join(ROOT, "assets/fonts/NotoSansCJK-Regular.otf");
const projectRequire = createRequire(path.join(ROOT, "package.json"));
const moduleCache = new Map<string, Record<string, unknown>>();

export type NativeGenerator = {
  createExamPdfWithManifest: (
    questions: PdfQuestion[],
    options?: { inputText?: string; examId?: string },
  ) => Promise<{ base64: string; manifest: WorksheetManifest }>;
  createExamPdf: (input: PdfQuestion[] | WorksheetManifest) => Promise<string>;
  createAnswerPdf: (input: string[] | WorksheetManifest) => Promise<string>;
};

/** The key belongs to the worksheet; an explicitly empty studentAnswer is a blank response. */
export type WorksheetFixtureRow = {
  prompt: string;
  answer: string;
  studentAnswer?: string;
  direction?: QuestionDirection;
  sourceTerm?: string;
  sourceMeaning?: string;
};

export type ActualWorksheetOptions = {
  /** Deliberately moves only student ink, for overflow safety fixtures. */
  answerX?: number;
  examId?: string;
  inputText?: string;
};

export type ActualWorksheet = {
  pdfBytes: Uint8Array;
  manifest: WorksheetManifest;
  questions: PdfQuestion[];
};

function loadActualTsModule(file: string): Record<string, unknown> {
  const resolved = path.resolve(file);
  const cached = moduleCache.get(resolved);
  if (cached) return cached;

  const ts = projectRequire("typescript") as typeof import("typescript");
  const compiled = ts.transpileModule(readFileSync(resolved, "utf8"), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
    },
  }).outputText;
  const module = { exports: {} as Record<string, unknown> };
  moduleCache.set(resolved, module.exports);

  const localRequire = (name: string): unknown => {
    // These are the only mobile dependencies stubbed: all PDF/layout code is the actual source.
    if (name === "expo-asset") {
      return { Asset: { fromModule: () => ({ downloadAsync: async () => undefined, localUri: FONT_PATH }) } };
    }
    if (name === "expo-file-system/legacy") {
      return {
        EncodingType: { Base64: "base64" },
        readAsStringAsync: async () => readFileSync(FONT_PATH).toString("base64"),
      };
    }
    if (name === "react-native") return { Platform: { OS: "android" } };
    if (name.endsWith(".otf")) return FONT_PATH;
    if (name === "pdf-lib/dist/pdf-lib.esm.js") return projectRequire("pdf-lib");

    if (name.startsWith(".")) {
      const candidate = path.resolve(path.dirname(resolved), name);
      const target = candidate.endsWith(".ts") ? candidate : `${candidate}.ts`;
      return loadActualTsModule(target);
    }
    return projectRequire(name);
  };

  new Function("require", "module", "exports", "__filename", "__dirname", compiled)(
    localRequire,
    module,
    module.exports,
    resolved,
    path.dirname(resolved),
  );
  return module.exports;
}

/** Actual lib/native-pdf.ts, transpiled as CJS with Expo asset/filesystem stubs only. */
export function nativeGenerator(): NativeGenerator {
  return loadActualTsModule(path.join(ROOT, "lib/native-pdf.ts")) as unknown as NativeGenerator;
}

/** Makes contiguous app-source questions; validation and layout still happen in lib/native-pdf.ts. */
export function generateRows(rows: WorksheetFixtureRow[]): PdfQuestion[] {
  return rows.map(({ studentAnswer: _studentAnswer, ...row }, index) => ({ number: index + 1, ...row }));
}

function fontFor(value: string, korean: Awaited<ReturnType<PDFDocument["embedFont"]>>, latin: typeof korean) {
  return /[\uac00-\ud7a3]/.test(value) ? korean : latin;
}

/**
 * Calls the actual app generator, reloads its base64 PDF, and writes student ink at
 * the generated manifest placement. `answer` remains the independent answer key.
 */
export async function createExamPdfWithManifest(
  rows: WorksheetFixtureRow[],
  options: ActualWorksheetOptions = {},
): Promise<ActualWorksheet> {
  const questions = generateRows(rows);
  const generated = await nativeGenerator().createExamPdfWithManifest(questions, {
    examId: options.examId ?? "vp-test-fixture",
    inputText: options.inputText,
  });
  const pdf = await PDFDocument.load(Buffer.from(generated.base64, "base64"));
  pdf.registerFontkit(fontkit);
  const korean = await pdf.embedFont(readFileSync(FONT_PATH), { subset: false });
  const latin = await pdf.embedFont(StandardFonts.Helvetica);

  generated.manifest.questions.forEach((question, index) => {
    // Nullish fallback is intentional: "" is a student's blank answer, not a blank key.
    const studentAnswer = rows[index].studentAnswer ?? rows[index].answer;
    if (!studentAnswer) return;
    pdf.getPage(question.pageNumber - 1).drawText(studentAnswer, {
      x: options.answerX ?? question.answerRect.x,
      y: question.baselineY,
      size: 12,
      font: fontFor(studentAnswer, korean, latin),
    });
  });
  // PDFDocument.load/save keeps metadata, and setting it explicitly makes that invariant testable.
  pdf.setSubject(worksheetPdfMarker(generated.manifest, "exam"));

  return { pdfBytes: await pdf.save(), manifest: generated.manifest, questions };
}

import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { publicProcedure } from "../_core/trpc";
import { assertWorksheetManifest, type WorksheetManifest } from "../../lib/worksheet-layout";
import type { HybridOptions } from "./hybrid-pipeline";

/** Tests inject an invoker without changing the real server/model/retry contract. */
export function createWorksheetHybridProcedures(options: HybridOptions = {}) {
  return {
    gradingCapabilities: publicProcedure.query(() => ({
      hybridEnabled: process.env.VOCAB_POCKET_HYBRID_ENABLED === "1",
    })),
    gradeHybridPdf: publicProcedure.input(z.object({
      storageKey: z.string().uuid(),
      // Same shared manifest type; runtime validation happens INSIDE cleanup scope.
      // Pre-handler rejection must not strand an uploaded student's PDF.
      manifest: z.custom<WorksheetManifest>().optional(),
    })).mutation(async ({ input }) => {
      const filePath = path.join(os.tmpdir(), "vocab-pocket-pdfs", `${input.storageKey}.pdf`);
      try {
        if (process.env.VOCAB_POCKET_HYBRID_ENABLED !== "1") {
          throw new TRPCError({ code: "PRECONDITION_FAILED", message: "자체/hybrid 채점은 이 서버에서 활성화되지 않았습니다." });
        }
        const manifest: unknown = input.manifest;
        try {
          assertWorksheetManifest(manifest);
          if (!manifest.questions.length) throw new Error("empty manifest");
        } catch {
          throw new TRPCError({ code: "BAD_REQUEST", message: "저장된 시험지 manifest가 유효하지 않습니다. 시험지를 다시 생성해 주세요." });
        }
        // Narrowing above is the existing shared validator, not a duplicated DTO.
        assertWorksheetManifest(manifest);
        let pdfBytes: Buffer;
        try { pdfBytes = await fs.readFile(filePath); }
        catch { throw new TRPCError({ code: "NOT_FOUND", message: "업로드한 PDF를 찾을 수 없습니다. 다시 업로드해 주세요." }); }

        // Lazy at source level; production bundlers may still hoist native dependencies.
        const { validatePdfManifest } = await import("./manifest");
        try { await validatePdfManifest(pdfBytes, manifest); }
        catch {
          throw new TRPCError({ code: "BAD_REQUEST", message: "PDF와 저장된 시험지 manifest의 ID·버전·페이지 규격이 일치하지 않습니다. 스캔 metadata가 사라진 PDF는 위치를 추정해 채점하지 않습니다." });
        }
        const { gradeFixedLayoutPdfHybrid } = await import("./hybrid-pipeline");
        const graded = await gradeFixedLayoutPdfHybrid(pdfBytes, manifest, options);
        // Defense at the public API boundary; review items never contribute to a score.
        const results = graded.results.map(result => ({ ...result, correct: result.correct && !result.needsReview }));
        return {
          ...graded,
          results,
          score: results.filter(result => result.correct && !result.needsReview).length,
          total: results.length,
          reviewCount: results.filter(result => result.needsReview).length,
        };
      } finally {
        await fs.unlink(filePath).catch(() => undefined);
      }
    }),
  };
}

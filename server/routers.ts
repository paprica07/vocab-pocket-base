import { COOKIE_NAME } from "../shared/const.js";
import { getSessionCookieOptions } from "./_core/cookies";
import { invokeLLM } from "./_core/llm";
import { systemRouter } from "./_core/systemRouter";
import { publicProcedure, router } from "./_core/trpc";
import { z } from "zod";
import { promises as fs } from "fs";
import os from "os";
import path from "path";
import { createWorksheetHybridProcedures } from "./grading/router";

export const appRouter = router({
  // if you need to use socket.io, read and register route in server/_core/index.ts, all api should start with '/api/' so that the gateway can route correctly
  system: systemRouter,
  auth: router({
    me: publicProcedure.query((opts) => opts.ctx.user),
    logout: publicProcedure.mutation(({ ctx }) => {
      const cookieOptions = getSessionCookieOptions(ctx.req);
      ctx.res.clearCookie(COOKIE_NAME, { ...cookieOptions, maxAge: -1 });
      return {
        success: true,
      } as const;
    }),
  }),

    worksheet: router({
    ...createWorksheetHybridProcedures(),
    gradePdf: publicProcedure
      .input(
        z.object({
          storageKey: z.string().uuid(),
          words: z
            .array(z.object({ term: z.string(), meaning: z.string() }))
            .min(1)
            .max(200),
          questions: z
            .array(z.object({
              number: z.number().int().positive(),
              prompt: z.string(),
              answer: z.string(),
              direction: z.enum(["engkor", "koreng"]).optional(),
            }))
            .min(1)
            .max(200)
            .optional(),
        }),
      )
      .mutation(async ({ ctx, input }) => {
        const protoHeader = ctx.req.headers["x-forwarded-proto"];
        const protocol =
          (Array.isArray(protoHeader) ? protoHeader[0] : protoHeader)?.split(",")[0]?.trim() ||
          ctx.req.protocol ||
          "https";

        const host = ctx.req.headers.host;
        if (!host) {
          throw new Error("PDF 서버 주소를 확인할 수 없습니다.");
        }

        const pdfUrl = `${protocol}://${host}/api/worksheet/pdf/${input.storageKey}`;

        try {
          const response = await invokeLLM({
            model: "gemini-3.5-flash",
            maxTokens: 12000,
            messages: [{
              role: "user",
              content: [
                {
                  type: "text",
                  text: `You are a STRICT and UNYIELDING grader for a vocabulary test. Inspect every page of the attached PDF visually (printed text, typed text, or Korean/English handwriting). First, locate question numbers and the student's answer for each number. Match answers to this answer key.
                  STRICT GRADING RULES:
                  1. DO NOT accept spelling errors, Exact spelling is required.
                  2. DO NOT accept loose equivalent meanings; the answer must accurately match the exact intent and core meaning of the provided answer key.
                  3. If the handwriting is ambiguous, illegible, or heavily corrected without clear intent, mark it as INCORRECT ('correct': false) and note it. Never guess unreadable text.
                  Return one result per key word in the same order. Answer key JSON: ${JSON.stringify(input.words)}
                  ${input.questions ? `Question manifest JSON (use this to preserve the PDF's exact order and direction): ${JSON.stringify(input.questions)}` : ""}`,
                },
                {
                  type: "file_url",
                  file_url: {
                    url: pdfUrl,
                    mime_type: "application/pdf",
                  },
                },
              ],
            }],
            responseFormat: {
              type: "json_schema",
              json_schema: {
                name: "vocabulary_grade",
                strict: true,
                schema: {
                  type: "object",
                  properties: {
                    results: {
                      type: "array",
                      items: {
                        type: "object",
                        properties: {
                          number: { type: "integer" },
                          term: { type: "string" },
                          expected: { type: "string" },
                          answer: { type: "string" },
                          correct: { type: "boolean" },
                          confidence: { type: "number" },
                          note: { type: "string" },
                        },
                        required: [
                          "number",
                          "term",
                          "expected",
                          "answer",
                          "correct",
                          "confidence",
                          "note",
                        ],
                      },
                    },
                  },
                  required: ["results"],
                },
              },
            },
          });

          const content = response.choices[0]?.message.content;

          if (typeof content !== "string") {
            throw new Error("AI grading returned no structured result");
          }

          return JSON.parse(content) as {
            results: Array<{
              number: number;
              term: string;
              expected: string;
              answer: string;
              correct: boolean;
              confidence: number;
              note: string;
            }>;
          };
        } finally {
          const tempPdfPath = path.join(
            os.tmpdir(),
            "vocab-pocket-pdfs",
            `${input.storageKey}.pdf`,
          );

          await fs.unlink(tempPdfPath).catch(() => undefined);
        }
      }),
  }),

  // TODO: add feature routers here, e.g.
  // todo: router({
  //   list: protectedProcedure.query(({ ctx }) =>
  //     db.getUserTodos(ctx.user.id)
  //   ),
  // }),
});

export type AppRouter = typeof appRouter;

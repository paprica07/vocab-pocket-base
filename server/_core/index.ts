import "dotenv/config";
import express from "express";
import { createServer } from "http";
import net from "net";
import { promises as fs } from "fs";
import os from "os";
import path from "path";
import { randomUUID } from "crypto";
import { pathToFileURL } from "node:url";
import type { AnyRouter } from "@trpc/server";
import { createExpressMiddleware } from "@trpc/server/adapters/express";
import { registerOAuthRoutes } from "./oauth";
import { registerStorageProxy } from "./storageProxy";
import { appRouter } from "../routers";
import { createContext } from "./context";

function isPortAvailable(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.listen(port, () => {
      server.close(() => resolve(true));
    });
    server.on("error", () => resolve(false));
  });
}

async function findAvailablePort(startPort: number = 3000): Promise<number> {
  for (let port = startPort; port < startPort + 20; port++) {
    if (await isPortAvailable(port)) {
      return port;
    }
  }
  throw new Error(`No available port found starting from ${startPort}`);
}

export async function createApiApp(trpcRouter: AnyRouter = appRouter) {
  const app = express();

  // Enable CORS for all routes - reflect the request origin to support credentials
  app.use((req, res, next) => {
    const origin = req.headers.origin;
    if (origin) {
      res.header("Access-Control-Allow-Origin", origin);
    }
    res.header("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
    res.header(
      "Access-Control-Allow-Headers",
      "Origin, X-Requested-With, Content-Type, Accept, Authorization",
    );
    res.header("Access-Control-Allow-Credentials", "true");

    // Handle preflight requests
    if (req.method === "OPTIONS") {
      res.sendStatus(200);
      return;
    }
    next();
  });

  app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ limit: "50mb", extended: true }));

const tempPdfDir = path.join(os.tmpdir(), "vocab-pocket-pdfs");
await fs.mkdir(tempPdfDir, { recursive: true });

app.post(
  "/api/worksheet/upload-pdf",
  express.raw({ type: "application/pdf", limit: "50mb" }),
  async (req, res) => {
    try {
      if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
        res.status(400).json({ error: "PDF 파일이 비어 있습니다." });
        return;
      }

      const token = randomUUID();
      const filePath = path.join(tempPdfDir, `${token}.pdf`);

      await fs.writeFile(filePath, req.body);

      res.json({ key: token });
    } catch (error) {
      console.error("[PDF Upload] failed:", error);
      res.status(500).json({
        error: error instanceof Error ? error.message : "PDF 업로드에 실패했습니다.",
      });
    }
  },
);

app.get("/api/worksheet/pdf/:token", async (req, res) => {
  try {
    const token = req.params.token;

    if (!/^[0-9a-f-]{36}$/i.test(token)) {
      res.status(400).send("Invalid PDF token");
      return;
    }

    const filePath = path.join(tempPdfDir, `${token}.pdf`);

    try {
      await fs.access(filePath);
    } catch {
      res.status(404).send("PDF not found");
      return;
    }

    res.type("application/pdf");
    res.sendFile(filePath);
  } catch (error) {
    console.error("[PDF Serve] failed:", error);
    res.status(500).send("PDF serve error");
  }
});

  registerStorageProxy(app);
  registerOAuthRoutes(app);

  app.get("/api/health", (_req, res) => {
    res.json({ ok: true, timestamp: Date.now() });
  });

  app.use(
    "/api/trpc",
    createExpressMiddleware({
      router: trpcRouter,
      createContext,
    }),
  );

  return app;
}

async function startServer() {
  const app = await createApiApp();
  const server = createServer(app);
  const preferredPort = parseInt(process.env.PORT || "3000");
  const port = await findAvailablePort(preferredPort);

  if (port !== preferredPort) {
    console.log(`Port ${preferredPort} is busy, using port ${port} instead`);
  }

  server.listen(port, () => {
    console.log(`[api] server listening on port ${port}`);
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  startServer().catch(console.error);
}

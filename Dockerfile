# Vocab Pocket server image (Phase 1.5: Poppler renderer).
#
# Build context is the repository root, because the server build script lives in
# the root package.json ("esbuild server/_core/index.ts").
#
#   docker build -t vocab-pocket-server .
#   docker run --rm --memory=512m vocab-pocket-server pnpm exec tsx scripts/verify-poppler-grading.ts

FROM node:24-bookworm-slim

# Poppler supplies pdftoppm / pdftocairo / pdfinfo used by server/grading/poppler-render.ts.
# poppler-data + fonts-urw-base35 provide the base-14 font data (Helvetica, and the
# underscore underline drawn by pdf-lib). Without them the underline renders as a
# broken dashed line and Tesseract confidence collapses (verified in this image).
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
       poppler-utils \
       poppler-data \
       fonts-urw-base35 \
       ca-certificates \
  && rm -rf /var/lib/apt/lists/*

ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
# Preserve the repository's .npmrc node-linker setting without copying .npmrc.
ENV NPM_CONFIG_NODE_LINKER=hoisted

# Match the pnpm version pinned in package.json ("packageManager": "pnpm@9.12.0").
RUN if command -v corepack >/dev/null 2>&1; then \
      corepack enable && corepack prepare pnpm@9.12.0 --activate; \
    else \
      npm install -g pnpm@9.12.0; \
    fi

WORKDIR /app

# Dependency layer first so code-only changes reuse the cached install.
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

COPY . .
RUN pnpm build

ENV NODE_ENV=production
ENV PORT=10000
EXPOSE 10000

CMD ["pnpm", "start"]

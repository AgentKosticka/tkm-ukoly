# syntax=docker/dockerfile:1

# ── Závislosti ────────────────────────────────────────────────────────────
# Instalují se přesně podle package-lock.json a bez instalačních skriptů
# balíčků; nativní moduly (sharp, better-sqlite3) dodávají hotové binárky.
FROM node:24-trixie-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

# ── Běhový obraz ──────────────────────────────────────────────────────────
FROM node:24-trixie-slim AS runtime

# libjxl-tools dodává cjxl a djxl pro bezeztrátový archiv fotek.
RUN apt-get update \
 && apt-get install -y --no-install-recommends libjxl-tools \
 && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000 \
    DATA_DIR=/data \
    # Méně fragmentace paměti při zpracování obrázků (doporučení sharp pro glibc).
    MALLOC_ARENA_MAX=2

WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src
COPY public ./public

# Data (databáze, fotky, zálohy) žijí ve svazku; aplikace běží bez práv roota.
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME /data
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD ["node", "src/healthcheck.js"]

CMD ["node", "src/server.js"]

# ── Testy ─────────────────────────────────────────────────────────────────
# docker build --target test .   spustí celou sadu testů ve stejném prostředí,
# v jakém aplikace poběží, včetně skutečných nástrojů JPEG XL.
FROM runtime AS test
COPY test ./test
ENV NODE_ENV=test
RUN npm test

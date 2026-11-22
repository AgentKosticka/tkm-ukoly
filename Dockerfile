# syntax=docker/dockerfile:1

# ── Závislosti ────────────────────────────────────────────────────────────
# Instalují se přesně podle package-lock.json a bez instalačních skriptů
# balíčků; nativní moduly (sharp, better-sqlite3) dodávají hotové binárky.
FROM node:24-trixie-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

# ── Společný základ ───────────────────────────────────────────────────────
FROM node:24-trixie-slim AS base

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
# Do /photos se připojuje vlastní složka pro fotky, pokud je nastavená.
RUN mkdir -p /data /photos && chown node:node /data /photos
USER node

# ── Testy ─────────────────────────────────────────────────────────────────
# docker build --target test .   pustí celou sadu testů ve stejném prostředí,
# v jakém aplikace poběží. EXPECT_JXL=1 vyžaduje, aby nástroje JPEG XL
# opravdu fungovaly; bez nich by testy jinak prošly záložní cestou.
# Tahle fáze se při běžném sestavení přeskakuje.
FROM base AS test
COPY test ./test
ENV EXPECT_JXL=1
RUN npm test

# ── Běhový obraz (výchozí cíl) ────────────────────────────────────────────
FROM base AS runtime
VOLUME /data
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD ["node", "src/healthcheck.js"]

CMD ["node", "src/server.js"]

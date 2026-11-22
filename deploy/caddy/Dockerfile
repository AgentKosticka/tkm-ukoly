# Caddy s konfigurací přímo v obrazu. Díky tomu služba nepotřebuje připojovat
# soubory z hostitele a aktualizační služba ji umí bezpečně znovu vytvořit.
# Obraz nese konfiguraci pro oba režimy; který se použije, určuje Compose.
FROM caddy:2-alpine
COPY Caddyfile Caddyfile.tunnel web.caddy /etc/caddy/
RUN caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile \
 && caddy validate --config /etc/caddy/Caddyfile.tunnel --adapter caddyfile

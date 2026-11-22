# Caddy s konfigurací přímo v obrazu. Díky tomu služba nepotřebuje připojovat
# soubory z hostitele a aktualizační služba ji umí bezpečně znovu vytvořit.
FROM caddy:2-alpine
COPY Caddyfile /etc/caddy/Caddyfile
RUN caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile

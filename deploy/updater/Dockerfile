# Aktualizační služba: git a klient Dockeru (včetně Compose a buildx).
FROM docker:29-cli
RUN apk add --no-cache git su-exec
COPY loop.sh /usr/local/bin/updater-loop
RUN chmod 755 /usr/local/bin/updater-loop
WORKDIR /repo
CMD ["/usr/local/bin/updater-loop"]

#!/bin/sh
# Jedno kolo aktualizace: zjistí, zda v původním repozitáři přibyly změny,
# a pokud ano, bezpečně je nasadí.
#
#  - Sleduje vzdálený repozitář "origin", tedy ten, ze kterého byl projekt
#    naklonován, a větev, která je právě vybraná (nebo UPDATE_BRANCH).
#  - Přijme jen změny, které na místní stav navazují (fast-forward), a jen
#    když v pracovní složce nejsou neuložené úpravy sledovaných souborů.
#  - Po nasazení čeká, až budou služby zdravé. Když se sestavení nebo start
#    nepovede, vrátí předchozí verzi a vadnou revizi si zapamatuje, aby ji
#    nezkoušela pořád dokola.
#  - Sama sebe (službu updater) nikdy znovu nevytváří.
set -eu

REPO="${REPO_DIR:-/repo}"
STATE="${STATE_DIR:-/state}"
SERVICES="app caddy"
WAIT_SECONDS="${UPDATE_WAIT_SECONDS:-180}"

log() { echo "[aktualizace $(date -u +%Y-%m-%dT%H:%M:%SZ)] $*"; }

cd "$REPO"

# Git běží pod vlastníkem složky, aby po stažení změn nezůstaly v repozitáři
# soubory patřící rootovi.
owner="$(stat -c '%u:%g' .)"
run_git() {
  if [ "$(id -u)" = "0" ] && command -v su-exec >/dev/null 2>&1; then
    su-exec "$owner" env HOME=/tmp GIT_TERMINAL_PROMPT=0 git "$@"
  else
    HOME="${HOME:-/tmp}" GIT_TERMINAL_PROMPT=0 git "$@"
  fi
}

# Soukromý repozitář: token se předá jen tomuto volání gitu, nikam se neukládá.
fetch() {
  if [ -n "${GIT_TOKEN:-}" ]; then
    # shellcheck disable=SC2016
    run_git -c credential.helper= \
      -c 'credential.helper=!f() { echo username=x-access-token; echo "password=${GIT_TOKEN}"; }; f' \
      fetch --quiet --prune origin "$1"
  else
    run_git fetch --quiet --prune origin "$1"
  fi
}

# Soubory sestavy vyjmenované v COMPOSE_FILE (režim za tunelem) hledá Compose
# vůči pracovní složce, ne vůči --project-directory; proto to cd výše.
compose() { docker compose --project-directory "$REPO" "$@"; }

deploy() {
  # shellcheck disable=SC2086
  compose build $SERVICES &&
    compose up -d --no-deps --wait --wait-timeout "$WAIT_SECONDS" $SERVICES
}

branch="${UPDATE_BRANCH:-}"
if [ -z "$branch" ]; then branch="$(run_git rev-parse --abbrev-ref HEAD)"; fi
if [ "$branch" = "HEAD" ]; then
  log "Repozitář není na žádné větvi, není co sledovat."
  exit 0
fi

if ! fetch "$branch"; then
  log "Nepodařilo se spojit s repozitářem."
  exit 0
fi

current="$(run_git rev-parse HEAD)"
latest="$(run_git rev-parse "origin/$branch")"
[ "$current" = "$latest" ] && exit 0

mkdir -p "$STATE"
if [ -f "$STATE/failed" ] && [ "$(cat "$STATE/failed")" = "$latest" ]; then
  # Tahle revize už jednou selhala; čeká se na opravu v repozitáři.
  exit 0
fi

if ! run_git merge-base --is-ancestor "$current" "$latest"; then
  log "Vzdálená větev nenavazuje na místní stav (přepsaná historie nebo místní commity). Aktualizace vyžaduje ruční zásah."
  exit 0
fi

if ! run_git diff --quiet || ! run_git diff --cached --quiet; then
  log "V pracovní složce jsou neuložené úpravy. Aktualizace vyžaduje ruční zásah."
  exit 0
fi

log "Nová verze: $(echo "$current" | cut -c1-8) → $(echo "$latest" | cut -c1-8)"
run_git merge --ff-only --quiet "origin/$branch"

if deploy; then
  rm -f "$STATE/failed"
  docker image prune -f >/dev/null 2>&1 || true
  log "Hotovo, běží verze $(echo "$latest" | cut -c1-8)."
  exit 0
fi

log "Nasazení selhalo, vracím verzi $(echo "$current" | cut -c1-8)."
echo "$latest" > "$STATE/failed"
run_git reset --hard --quiet "$current"
if deploy; then
  log "Předchozí verze znovu běží."
else
  log "Ani návrat k předchozí verzi se nepodařil. Je potřeba ruční zásah: docker compose up -d --build"
fi
exit 1

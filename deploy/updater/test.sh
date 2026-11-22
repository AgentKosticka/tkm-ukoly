#!/bin/sh
# Test aktualizačního skriptu bez Dockeru: místo něj se na PATH podstrčí
# náhražka, která jen zapisuje, s čím byla zavolána, a na pokyn selže.
#
#   sh deploy/updater/test.sh            (volitelně: SH=dash sh deploy/updater/test.sh)
set -eu

SCRIPT="$(cd "$(dirname "$0")" && pwd)/update.sh"
SH="${SH:-sh}"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

export GIT_AUTHOR_NAME=test GIT_AUTHOR_EMAIL=test@example.invalid
export GIT_COMMITTER_NAME=test GIT_COMMITTER_EMAIL=test@example.invalid
export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_SYSTEM=/dev/null

mkdir -p "$WORK/bin" "$WORK/state"
cat > "$WORK/bin/docker" <<'STUB'
#!/bin/sh
echo "$*" >> "$STUB_LOG"
case " $* " in
  *" build "*) [ -f "$STUB_DIR/fail-build" ] && exit 1 ;;
  *" up "*) [ -f "$STUB_DIR/fail-up" ] && exit 1 ;;
esac
exit 0
STUB
chmod +x "$WORK/bin/docker"
export STUB_DIR="$WORK" STUB_LOG="$WORK/docker.log"
export PATH="$WORK/bin:$PATH"

git init -q --bare -b main "$WORK/origin.git"
git clone -q "$WORK/origin.git" "$WORK/dev" 2>/dev/null
cd "$WORK/dev"
git checkout -q -b main
echo v1 > app.txt
git add app.txt
git commit -q -m v1
git push -q origin main
git clone -q "$WORK/origin.git" "$WORK/server"

passed=0
fail() { echo "SELHALO: $1" >&2; exit 1; }
ok() { passed=$((passed + 1)); echo "ok   $1"; }

run() {
  : > "$STUB_LOG"
  # shellcheck disable=SC2086
  REPO_DIR="$WORK/server" STATE_DIR="$WORK/state" $SH "$SCRIPT" > "$WORK/out.log" 2>&1 && status=0 || status=$?
}
head_of() { git -C "$1" rev-parse HEAD; }
publish() { # publish <obsah> <zpráva>
  cd "$WORK/dev"
  echo "$1" > app.txt
  git commit -q -am "$2"
  git push -q origin main
}
calls() { wc -l < "$STUB_LOG" | tr -d ' '; }

# 1. Beze změn se nic neděje.
run
[ "$status" = 0 ] || fail "beze změn má skript skončit v pořádku"
[ "$(calls)" = 0 ] || fail "beze změn se nemá volat Docker"
ok "beze změn žádná akce"

# 2. Nový commit se stáhne, sestaví a nasadí.
publish v2 v2
run
[ "$status" = 0 ] || fail "aktualizace měla projít: $(cat "$WORK/out.log")"
[ "$(head_of "$WORK/server")" = "$(head_of "$WORK/dev")" ] || fail "server nemá novou verzi"
grep -q "build app caddy" "$STUB_LOG" || fail "chybí sestavení"
grep -q "up -d --no-deps --wait --wait-timeout 180 app caddy" "$STUB_LOG" || fail "chybí nasazení s čekáním na zdraví"
grep -q "image prune" "$STUB_LOG" || fail "chybí úklid starých obrazů"
if grep -q "updater" "$STUB_LOG"; then fail "aktualizační služba nesmí měnit sama sebe"; fi
ok "nový commit se nasadí"

# 3. Když sestavení selže, vrátí se předchozí verze.
good="$(head_of "$WORK/server")"
publish rozbite v3-rozbite
bad="$(head_of "$WORK/dev")"
touch "$WORK/fail-build"
run
[ "$status" != 0 ] || fail "selhání sestavení má skončit chybou"
[ "$(head_of "$WORK/server")" = "$good" ] || fail "po selhání má zůstat předchozí verze"
[ "$(cat "$WORK/server/app.txt")" = "v2" ] || fail "soubory se nevrátily"
[ "$(cat "$WORK/state/failed")" = "$bad" ] || fail "vadná revize se nezapamatovala"
ok "selhání sestavení → návrat k předchozí verzi"
rm "$WORK/fail-build"

# 4. Vadná revize se nezkouší pořád dokola.
run
[ "$status" = 0 ] || fail "opakované kolo má skončit v pořádku"
[ "$(calls)" = 0 ] || fail "vadná revize se nesmí zkoušet znovu"
[ "$(head_of "$WORK/server")" = "$good" ] || fail "verze se nesmí změnit"
ok "vadná revize se neopakuje"

# 5. Oprava v repozitáři se nasadí a poznámka o selhání zmizí.
publish v4 v4-oprava
run
[ "$status" = 0 ] || fail "oprava měla projít: $(cat "$WORK/out.log")"
[ "$(head_of "$WORK/server")" = "$(head_of "$WORK/dev")" ] || fail "oprava se nenasadila"
[ ! -f "$WORK/state/failed" ] || fail "poznámka o selhání měla zmizet"
ok "oprava se nasadí"

# 6. Když po startu není služba zdravá, vrátí se předchozí verze.
good="$(head_of "$WORK/server")"
publish v5 v5-nenastartuje
touch "$WORK/fail-up"
run
[ "$status" != 0 ] || fail "nezdravý start má skončit chybou"
[ "$(head_of "$WORK/server")" = "$good" ] || fail "po nezdravém startu má zůstat předchozí verze"
grep -q "Ani návrat" "$WORK/out.log" || fail "má upozornit, že nejde ani návrat"
ok "nezdravý start → návrat a upozornění"
rm "$WORK/fail-up"
rm -f "$WORK/state/failed"
run
[ "$(head_of "$WORK/server")" = "$(head_of "$WORK/dev")" ] || fail "po odstranění překážky se má verze nasadit"
ok "po odstranění překážky se nasadí"

# 7. Místní neuložené úpravy se nepřepíšou.
echo "rucni zasah" > "$WORK/server/app.txt"
publish v6 v6
before="$(head_of "$WORK/server")"
run
[ "$(calls)" = 0 ] || fail "s místními úpravami se nemá nasazovat"
[ "$(head_of "$WORK/server")" = "$before" ] || fail "verze se nesmí změnit"
[ "$(cat "$WORK/server/app.txt")" = "rucni zasah" ] || fail "místní úprava byla přepsána"
grep -q "neuložené úpravy" "$WORK/out.log" || fail "má vysvětlit důvod"
ok "místní úpravy se nepřepíšou"
git -C "$WORK/server" checkout -q -- app.txt
run
ok "po zahození úprav aktualizace pokračuje"

# 8. Přepsaná historie (force push) se nepřijme.
cd "$WORK/dev"
git reset -q --hard HEAD~2
echo jina > app.txt
git commit -q -am "jina-historie"
git push -q --force origin main
before="$(head_of "$WORK/server")"
run
[ "$(calls)" = 0 ] || fail "přepsaná historie se nemá nasazovat"
[ "$(head_of "$WORK/server")" = "$before" ] || fail "verze se nesmí změnit"
grep -q "nenavazuje" "$WORK/out.log" || fail "má vysvětlit důvod"
ok "přepsaná historie se odmítne"

# 9. Soubory zapsané z jiné větve neovlivní sledovanou větev.
cd "$WORK/dev"
git checkout -q -b pokus
echo pokus > app.txt
git commit -q -am pokus
git push -q origin pokus
run
[ "$(head_of "$WORK/server")" = "$before" ] || fail "cizí větev nesmí nic změnit"
ok "jiné větve se ignorují"

echo "Prošlo $passed kontrol."

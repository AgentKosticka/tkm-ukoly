#!/bin/sh
# Smyčka aktualizační služby. Samotný postup aktualizace (update.sh) se čte
# při každém kole přímo z repozitáře, takže se jeho opravy projeví samy,
# bez nového sestavení této služby.
set -u

interval="${UPDATE_INTERVAL:-300}"
case "$interval" in
  '' | *[!0-9]*) echo "UPDATE_INTERVAL musí být celé číslo sekund" >&2; exit 1 ;;
esac

if [ "$interval" -eq 0 ]; then
  echo "Automatické aktualizace jsou vypnuté (UPDATE_INTERVAL=0)."
  while :; do sleep 86400; done
fi
if [ "$interval" -lt 60 ]; then interval=60; fi

echo "Automatické aktualizace: kontrola každých ${interval} s."
while :; do
  sh /repo/deploy/updater/update.sh || echo "Kontrola aktualizací skončila chybou, zkusím to příště."
  sleep "$interval"
done

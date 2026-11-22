# Úkolníček ITV a TKM Litoměřice

Webová nástěnka úkolů pro Technický klub mládeže a Institut technického vzdělávání v Litoměřicích. Úkol je buď nesplněný, pracuje se na něm, nebo je splněný. Dá se rozkliknout, má popis, fotky a historii změn.

- **Kdokoliv** si může úkoly a fotky prohlížet.
- **Schválení členové** úkoly zakládají, upravují, mění jejich stav a přidávají fotky.
- **Správce** schvaluje nové registrace a spravuje účty.

Rozhraní je česky a drží se vizuálu [technickyklub.cz](https://www.technickyklub.cz/): barvy, písma i obě loga.

## Spuštění

Potřebujete stroj s Dockerem (včetně Docker Compose) a gitem.

```bash
git clone https://github.com/VAS-UCET/tkm-ukoly.git
cd tkm-ukoly
cp .env.example .env
docker compose up -d --build
```

Web pak běží na portu 80 tohoto stroje.

### První přihlášení

Při prvním startu se založí účet správce `admin`. Heslo najdete v logu:

```bash
docker compose logs app | grep -A3 "Vytvořen účet správce"
```

Po přihlášení si ho musíte hned změnit. Kdo chce heslo určit sám, vyplní před prvním startem v `.env` položku `ADMIN_PASSWORD` (aspoň 10 znaků).

### HTTPS

Bez domény běží web přes nešifrované HTTP. To stačí na vyzkoušení v místní síti, ale hesla po cestě nic nechrání. Pro ostrý provoz nastavte v `.env` doménu, která míří na váš server:

```
SITE_ADDRESS=ukoly.example.cz
```

a spusťte `docker compose up -d`. Caddy si certifikát obstará a obnovuje sám. Porty 80 a 443 musí být dostupné z internetu.

## Automatické aktualizace

Služba `updater` každých pět minut zjistí, jestli v repozitáři, ze kterého jste projekt naklonovali (`origin`), přibyly změny ve vybrané větvi. Když ano:

1. stáhne je (jen pokud navazují na místní stav),
2. sestaví nové obrazy; stará verze mezitím běží dál,
3. nasadí je a počká, až aplikace odpovídá,
4. když se sestavení nebo start nepovede, vrátí předchozí verzi a vadnou revizi už nezkouší, dokud v repozitáři nepřibude oprava.

Průběh je v logu: `docker compose logs updater`.

Místní neuložené úpravy sledovaných souborů ani přepsanou historii služba nepřepíše; v logu řekne, že je potřeba ruční zásah. Před změnou struktury databáze si aplikace sama uloží zálohu do `/data/backups`.

| Nastavení v `.env` | Význam |
| --- | --- |
| `UPDATE_INTERVAL=300` | Interval kontroly v sekundách. `0` aktualizace vypne. |
| `UPDATE_BRANCH=` | Sledovaná větev. Prázdné znamená větev, která je právě vybraná. |
| `GIT_TOKEN=` | Token pro čtení soukromého repozitáře na GitHubu. |

**Na co si dát pozor:** služba má přístup k Dockeru na hostiteli, což odpovídá právům správce stroje. Kdo může zapisovat do sledované větve, ten ovládá server. Chraňte ji (povinné revize, dvoufázové přihlášení) nebo aktualizace vypněte a nasazujte ručně:

```bash
git pull && docker compose up -d --build
```

Změny v samotné službě `updater` (soubor `deploy/updater/Dockerfile` nebo `loop.sh`) se neprojeví samy. Po nich jednou spusťte `docker compose up -d --build updater`. Postup aktualizace v `update.sh` se čte při každé kontrole znovu, ten se aktualizuje sám.

## Zálohy

Všechna data jsou ve svazku `tkm-ukoly_data`: databáze `ukoly.db`, fotky ve složce `photos` a denní zálohy databáze za posledních sedm dní ve složce `backups`.

Kopii celého svazku do aktuální složky udělá:

```bash
docker run --rm -v tkm-ukoly_data:/data:ro -v "$PWD":/zaloha alpine tar czf /zaloha/ukolnicek-zaloha.tar.gz -C /data .
```

Zálohy ve svazku chrání před poškozením databáze, ne před ztrátou disku. Kopii si pravidelně ukládejte jinam.

## Správa z příkazové řádky

Když se správce nemůže přihlásit:

```bash
docker compose exec app node src/cli.js uzivatele
docker compose exec app node src/cli.js reset-hesla JMENO
docker compose exec app node src/cli.js spravce JMENO
```

`reset-hesla` vypíše dočasné heslo, `spravce` udělá z existujícího účtu schváleného správce.

## Fotky

- Přijímají se jen JPEG, PNG a WebP do 20 MB. Typ se pozná z obsahu souboru, ne z přípony.
- Server každý soubor celý dekóduje. Poškozené soubory, animace a obrázky s obřím rozlišením odmítne.
- Z fotek se odstraní metadata včetně polohy GPS. Zůstane jen barevný profil a orientace.
- Na stránce se zobrazuje zmenšená verze ve WebP (náhled 480 px, detail 2000 px).
- **Originál se archivuje beze ztráty** ve formátu JPEG XL:
  - JPEG se přebalí tak, že je zhruba o pětinu menší a jde z něj vrátit původní soubor bajt po bajtu.
  - PNG a bezeztrátový WebP se uloží po pixelech, typicky na třetinu původní velikosti.
  - Ztrátový WebP zůstává, jak je, protože bezeztrátové překódování by ho několikanásobně zvětšilo.
- Server po zakódování archiv rozbalí a porovná s předlohou. Když nesedí nebo není menší, uloží očištěný původní soubor. Archiv tak nikdy není větší než nahraná fotka.
- Originál si přihlášený člen stáhne v prohlížeči fotek tlačítkem „Originál“.

Kódování do JPEG XL potřebuje zhruba 25–50 MB paměti na megapixel. Fotky nad 24 megapixelů se proto ukládají jako očištěný JPEG nebo PNG; hranici mění `JXL_MAX_MEGAPIXELS`.

## Zabezpečení

- Hesla se ukládají jako otisk scrypt (N = 2¹⁶, r = 8, p = 2). Minimum je 10 znaků.
- Přihlášení drží cookie `HttpOnly`, `SameSite=Strict`, přes HTTPS navíc `Secure` s prefixem `__Host-`. V databázi je jen otisk tokenu.
- Stav účtu se čte z databáze při každém požadavku. Zablokování nebo odebrání práv platí okamžitě.
- Požadavky, které něco mění, musí přijít ze stejné adresy a nést vlastní hlavičku (ochrana proti CSRF).
- Přísná Content-Security-Policy: stránka nenačítá nic z cizích serverů, písma i ikony jsou součástí aplikace.
- Po pěti špatných heslech se přihlášení z dané adresy na daný účet na 15 minut zablokuje. Účet se nezamyká jen podle jména, aby ho nešlo odstavit hádáním.
- Jména členů vidí jen přihlášení. Návštěvník vidí úkoly a fotky bez autorů.
- Aplikace běží v kontejneru bez práv roota, se souborovým systémem jen pro čtení a bez přístupu do internetu. Ven je vystavený jen Caddy.

Bez e-mailu nejde heslo obnovit samoobslužně. Zapomenuté heslo řeší správce: v seznamu uživatelů vytvoří dočasné, které si člen po přihlášení změní.

## Nastavení

Všechno se nastavuje v souboru `.env`; popis položek je v [.env.example](.env.example).

| Proměnná | Výchozí | Význam |
| --- | --- | --- |
| `SITE_ADDRESS` | `:80` | Doména pro HTTPS, nebo `:80` pro HTTP. |
| `HTTP_PORT`, `HTTPS_PORT` | `80`, `443` | Porty na hostiteli. |
| `ADMIN_USERNAME`, `ADMIN_PASSWORD` | `admin`, náhodné | První správce. |
| `UPDATE_INTERVAL`, `UPDATE_BRANCH`, `GIT_TOKEN` | `300`, prázdné, prázdné | Automatické aktualizace. |
| `PROXY_SUBNET` | `172.30.99.0/29` | Vnitřní síť mezi Caddy a aplikací. |
| `PUBLIC_ORIGIN` | prázdné | Pevná veřejná adresa pro kontrolu původu požadavků. |
| `JXL_MAX_MEGAPIXELS` | `24` | Největší fotka archivovaná v JPEG XL. |

## Vývoj

Potřebujete Node.js 22.12 nebo novější.

```bash
npm ci
npm run dev
```

Aplikace běží na `http://localhost:3000` a data ukládá do složky `data`. Heslo správce se vypíše do konzole.

```bash
npm test
sh deploy/updater/test.sh
```

Bez nástrojů `cjxl` a `djxl` (balík `libjxl-tools`) se originály ukládají záložní cestou; testy projdou v obou případech. Celou sadu ve stejném prostředí jako v provozu pustí `docker build --target test .`

```
src/          server: účty, úkoly, fotky
public/       rozhraní: čisté ES moduly a CSS, bez sestavovacího kroku
test/         testy serveru
deploy/       Caddy a aktualizační služba
compose.yml   provozní sestava
```

## Licence třetích stran

- Písma DM Sans, Space Grotesk a IBM Plex Mono: SIL Open Font License 1.1.
- Ikony: [Lucide](https://lucide.dev), licence ISC.
- Loga ITV a TKM patří Institutu technického vzdělávání, z. ú.

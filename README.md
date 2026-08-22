# proxy-downloader

Downloader con rotación de proxies, resume y modo batch. Arquitectura modular:
el backend de proxies y el motor de descarga son genéricos, cada sitio es un
plugin independiente.

```
downloader.py              punto de entrada (auto-detecta el sitio por la URL)
proxy_downloader/
  config.py                 constantes genéricas (timeouts, tamaños, etc.)
  utils.py                  helpers genéricos (sanitize, sha256, etc.)
  proxy/                     backend de rotación de proxies (no sabe nada de sitios)
    cache.py                 caché en disco de proxies buenos/malos
    pool.py                  validación + rotación
  core/
    base.py                  SiteProvider — la interfaz que implementa cada sitio
    downloader.py             motor de descarga genérico (resume, velocidad, integridad)
    registry.py                registro de sitios + auto-detección por dominio
  sites/
    pixeldrain.py             sitio con URL de descarga estable (caso simple)
    mediafire.py               sitio que necesita resolver el link en cada intento (caso avanzado)
    mega.py                     sitio con descifrado del lado del cliente (caso avanzado+)
    fichier.py                   sitio con countdown server-side + cookies de sesión (caso avanzado)
    gofile.py                     sitio con cuenta guest + token anti-scraping (caso avanzado)
    fileditch.py                   sitio con proof-of-work + link firmado ofuscado en JS (caso avanzado)
    bunkr.py                        sitio con álbumes paginados + resolución de link en 2 pasos (caso avanzado)
  webui/                      Flask + job manager en background — ver Web UI / Docker más abajo
webui.py                    punto de entrada del servidor web (interfaz)
```

> El foco del proyecto es la **Web UI / Docker** (ver más abajo) — es la
> forma recomendada de correrlo. La CLI (`downloader.py`) se mantiene
> funcionando igual, comparte el mismo motor de descarga, pero ya no es el
> punto de entrada principal.

## Uso

```bash
python downloader.py -f https://pixeldrain.com/u/XXXXXXX
python downloader.py -f https://www.mediafire.com/file/XXXXXXX/nombre/file
python downloader.py -f https://mega.nz/file/XXXXXXXX#clave
python downloader.py -f https://1fichier.com/?XXXXXXXXX
python downloader.py -f https://gofile.io/d/XXXXXXX      # archivo suelto
python downloader.py -F https://gofile.io/d/XXXXXXX      # o carpeta — mismo link, se detecta solo
python downloader.py -f https://fileditchfiles.st/XXXXXXX/XXXXXXX/nombre.ext
python downloader.py -f https://bunkr.si/f/XXXXXXX        # archivo suelto (o /i/, /v/)
python downloader.py -F https://bunkr.si/a/XXXXXXX        # álbum — cualquier dominio bunkr.*, no solo .si
python downloader.py -F https://pixeldrain.com/l/XXXXXXX
python downloader.py -b lista.txt          # batch, puede mezclar sitios distintos
python downloader.py --list-sites          # ver sitios y si usan proxy por defecto
python downloader.py --no-proxy -f XXXXXXX # sin proxies, para todos los sitios
python downloader.py --proxy -f XXXXXXX    # fuerza proxies aunque el sitio no los use por defecto
```

### Organizando el batch en subcarpetas

Una línea `folder: <nombre>` dentro del `.txt` de `-b` agrupa todo lo que viene
después en una subcarpeta de salida, hasta la próxima etiqueta (o hasta el
final del archivo):

```
folder: fotos de perritos
https://pixeldrain.com/u/XXXXXXX
https://www.mediafire.com/file/XXXXXXX/nombre/file

folder: otra tanda
https://mega.nz/file/XXXXXXXX#clave

folder:
https://1fichier.com/?XXXXXXXXX
```

`fotos de perritos` y `otra tanda` terminan como subcarpetas dentro de la
carpeta de salida (`-o`, por defecto `~/Downloads`); un `folder:` vacío vuelve
a la raíz. Las etiquetas no se tocan al re-correr el batch — solo los links
individuales se van marcando `# [OK]` / `# [FAILED]` como siempre.

> Notas de alcance:
> - Mega todavía no soporta carpetas (`-F`/links `/folder/`) — usa una API
>   distinta con claves por-archivo derivadas de la clave de la carpeta, y
>   preferí no adivinar ese protocolo. Los archivos sueltos funcionan completos
>   (descarga + descifrado + verificación de integridad).
> - 1fichier gratis/anónimo limita a ~1 descarga por IP por hora, pero además
>   **bloquea directo cualquier IP que identifique como datacenter/proxy/VPN**
>   ("professional infrastructure detected") — que es exactamente lo que son
>   los proxies gratuitos de esta lista. Por eso acá el proxy está
>   desactivado por defecto: con proxies gratis casi nunca ayuda, solo gasta
>   todo el pool pegando contra el mismo bloqueo. `--no-proxy` (tu IP real)
>   es lo que de verdad lo esquiva. Ver más abajo.
> - Gofile no distingue archivo de carpeta por la URL — `gofile.io/d/XXXXX`
>   sirve para ambos, se sabe cuál es recién al consultar la API. `-f` sobre
>   un link que resulta ser carpeta falla con un mensaje claro pidiendo `-F`
>   (y viceversa no aplica: `-F` sobre un archivo suelto lo baja igual,
>   adentro de una subcarpeta con el nombre del id). No soporta contenido con
>   contraseña.
> - FileDitch no tiene carpetas — solo `-f`. Cada link pide resolver un
>   desafío proof-of-work (hashcash: buscar un nonce cuyo SHA-256 tenga N
>   bits en cero) antes de entregar el link real, firmado y con expiración
>   corta — por eso se resuelve de cero en cada intento, igual que Mediafire.
>   No es una cuenta ni un login, solo cómputo (bien barato, <1s), así que no
>   hace falta nada especial de tu lado.
> - **Filester** (filester.gg) se evaluó pero no se implementó: el paso de
>   descarga final está detrás de DataDome (WAF anti-bot comercial), no algo
>   que se pueda resolver con cómputo local como el proof-of-work de
>   FileDitch — no es confiable de automatizar con `requests` y probablemente
>   empeora con proxies gratis (mala reputación de IP).
> - Bunkr cambia/agrega dominios espejo seguido (bunkr.si, .sk, .ph, .cr...)
>   para esquivar bloqueos, así que la detección no usa una lista fija de
>   dominios — acepta cualquier host cuyo nombre sea literalmente "bunkr"
>   (cualquier TLD). El link real de descarga sale en dos pasos (CDN +
>   firma con token que expira), resueltos de cero en cada intento, igual
>   que Mediafire/FileDitch.

El sitio se detecta automáticamente por el dominio de la URL (o, si es un ID
suelto, se usa el sitio marcado como default). No hace falta pasar `--site`.

### Proxy por sitio

Cada sitio trae un default (`use_proxy_by_default` en su clase). Pixeldrain,
Mega y Gofile lo usan por defecto (banean/limitan agresivo por IP en su tier
gratis/guest); Mediafire, FileDitch y Bunkr no — sus links de CDN no están
rate-limited de esa forma (el proof-of-work de FileDitch frena scraping
masivo, no una descarga puntual); 1fichier tampoco, pero por otra razón:
activamente bloquea IPs de datacenter/proxy (justo lo que son los proxies
gratis de esta lista). En un batch mixto, cada archivo usa el modo de su
propio sitio automáticamente — vas a ver `(proxy)` o `(direct)` en la
salida por cada uno.

**Velocidad mínima** (`--speed`, default 1500 KB/s): solo aplica cuando la
descarga va **con proxy** — si un proxy cae por debajo de eso, se
descarta y rota al siguiente. Sin proxy (`--no-proxy`, o un sitio con
`use_proxy_by_default = False`) no hay a qué rotar, así que este chequeo no
corre.

Hay tres niveles, de más a menos prioridad:

1. **`--no-proxy` / `--proxy`** — pisan todo, pero solo para esa corrida.
2. **Config por sitio, en `config/`** — un archivo independiente por sitio
   (`config/pixeldrain.json`, `config/mediafire.json`, etc.), que se genera
   solo la primera vez que corrés cualquier comando. Se puede editar a mano:
   ```json
   {
     "use_proxy": null,
     "_site_default_use_proxy": false
   }
   ```
   `use_proxy: null` = usar el default del sitio (`_site_default_use_proxy`
   te muestra cuál es, para no tener que ir a mirar `--list-sites` — es
   solo informativo, se recalcula solo y no hace falta tocarlo). Poné
   `true`/`false` en `use_proxy` para forzarlo, queda guardado entre
   corridas. También se puede hacer desde la terminal (edita el mismo
   archivo):
   ```bash
   python downloader.py --enable-proxy mediafire     # activarlo para ese sitio
   python downloader.py --disable-proxy pixeldrain    # desactivarlo
   python downloader.py --enable-proxy mega,1fichier  # varios a la vez
   python downloader.py --reset-proxy mediafire       # vuelve a null (default del sitio)
   ```
   `--list-sites` muestra el estado efectivo, marcando `(override)` cuando
   `config/<sitio>.json` tiene algo distinto de `null`.
3. **Default del sitio** — lo que trae cada uno si `use_proxy` quedó en `null`.

`config/` es la carpeta pensada para ir agregando más parámetros por sitio
más adelante (hoy solo tiene `use_proxy`) sin tocar el código Python de cada
uno.

### CAPTCHA y bloqueos por IP (1fichier)

1fichier bloquea directo cualquier IP que detecte como datacenter/proxy/VPN
("professional infrastructure detected") — verificado en vivo, es lo primero
que devuelve, antes del countdown. También puede pedir CAPTCHA en algunos
casos. Ninguno de los dos lo resolvemos automáticamente (no hay forma
confiable sin un servicio externo, y el bloqueo por IP no tiene bypass real
salvo usar una IP que no sea de datacenter). Cuando el sitio devuelve
cualquiera de estos, o un mensaje de "todavía tenés que esperar", el
proveedor levanta `RateLimited`: el motor **no** blacklistea ese proxy (sigue
sirviendo para otros sitios), simplemente prueba con el siguiente — aunque
con proxies gratis lo más probable es que el siguiente también esté
bloqueado, por eso el default acá es sin proxy. Si estás en `--no-proxy` y te
topás con esto (poco común desde una IP residencial real), no hay otra IP
para probar y el archivo queda marcado como fallido con un mensaje claro.

## Web UI / Docker

Interfaz web sobre el mismo motor de descarga: pegás una URL (o una carpeta,
o un batch de varias líneas), elegís carpeta de salida y modo de proxy, y
seguís el progreso de cada archivo desde el navegador. Corre siempre un
trabajo a la vez, en el mismo orden en que se encolan — igual que ir
corriendo la CLI repetidas veces.

El historial de trabajos (con su log) se persiste en `state/jobs.json`, así
que sobrevive redeploys/restarts del contenedor — cualquier trabajo que haya
quedado a mitad de camino cuando el proceso se cortó se marca como
"interrumpido" al reiniciar, sin re-lanzarlo solo. Desde cada trabajo podés:
**cancelar** uno que está corriendo (deja el `.part` en disco, listo para
resumir), **reintentar** solo los archivos que fallaron/se cancelaron (arranca
desde donde quedó el `.part`, no de cero), y **borrarlo** del historial una
vez terminado — o **"limpiar completados"** para vaciar todo lo terminado de
una. El historial también se poda solo, guardando como mucho los últimos 300
trabajos.

```bash
docker network create proxy   # una vez, salvo que ya tengas una red externa "proxy" (p. ej. la que usa tu Traefik)
docker compose up -d --build
```

Abrí `http://localhost:8080`. Por defecto:

- `./downloads` (host) → `/downloads` (contenedor) — ahí caen los archivos.
- `./config` (host) → `/app/config` — preferencias de proxy por sitio,
  persistentes (lo mismo que `config/*.json` en la CLI).
- `./state` (host) → `/app/state` — caché de proxies validados entre
  reinicios del contenedor.

Esas rutas y el puerto salen de variables de entorno con default (`WEB_PORT`,
`DOWNLOADS_PATH`, `CONFIG_PATH`, `STATE_PATH` — ver `.env.example`), así que
no hace falta tocar `docker-compose.yml` para cambiarlas: copiá
`.env.example` a `.env` y editalo, o si estás desplegando desde un stack
manager que lee el compose directo de este repo (Portainer, **Arcane**,
Dockge, etc. — donde el archivo suele quedar de solo lectura porque viene de
git), cargá esas mismas variables en la sección de "Environment
variables"/"Environment" del stack en su UI.

### Traefik

El compose ya trae los labels de Traefik, apagados por defecto
(`traefik.enable=false`) y controlados por variables de entorno — mismo
mecanismo que las rutas de arriba, no hace falta tocar el archivo:

```bash
TRAEFIK_ENABLE=true
TRAEFIK_HOST=downloader.tudominio.com
TRAEFIK_ENTRYPOINTS=websecure       # default
TRAEFIK_CERTRESOLVER=letsencrypt    # default
```

Requiere que el contenedor esté en la misma red externa que tu Traefik —
el compose ya lo conecta a una red externa llamada `proxy` (`docker network
create proxy` si todavía no la tenés; si tu Traefik usa otro nombre de red,
editá el `docker-compose.yml` local, ahí sí es un valor fijo, no variable).

Esta app no tiene login: cualquiera que llegue a la URL puede lanzar
descargas y browsear/borrar lo que hay en `/downloads`. Si la exponés por
Traefik a internet, considerá restringirla con un middleware de IP allowlist
(hay un ejemplo comentado en el propio `docker-compose.yml`) o dejarla solo
accesible por VPN/LAN.

Sin `docker compose`:

```bash
docker build -t proxy-downloader-webui .
docker run -d -p 8080:8080 \
  -v $(pwd)/downloads:/downloads \
  -v $(pwd)/config:/app/config \
  -v $(pwd)/state:/app/state \
  proxy-downloader-webui
```

Corriendo fuera de Docker (por ejemplo para desarrollo local):

```bash
pip install -r requirements-webui.txt
python webui.py                 # sirve en :8080 (PORT para cambiarlo)
```

`DOWNLOAD_DIR` (default `/downloads`) y `STATE_DIR` (default `/app/state`)
son configurables por variable de entorno; las preferencias por sitio siguen
viviendo en `config/` (relativo al directorio desde donde corrés el
proceso), igual que en la CLI.

La API REST que usa el frontend (`GET/POST /api/jobs`, `GET /api/jobs/<id>`,
`GET /api/jobs/<id>/log`, `POST /api/jobs/<id>/cancel`,
`POST /api/jobs/<id>/retry`, `DELETE /api/jobs/<id>`,
`POST /api/jobs/clear-finished`, `GET /api/sites`,
`POST /api/sites/<nombre>/proxy`, `GET/DELETE /api/files`,
`GET /api/files/download`) es la misma que consume la página — se puede
scriptear igual.

## Agregar un sitio nuevo

1. Creá `proxy_downloader/sites/<tunombre>.py` con una clase que herede de
   `SiteProvider` (`proxy_downloader/core/base.py`):

   ```python
   from ..core.base import SiteProvider
   from ..core.registry import register

   class MiSitioProvider(SiteProvider):
       name    = "misitio"
       domains = ["misitio.com"]
       use_proxy_by_default = True  # o False si el sitio no lo necesita

       def extract_file_id(self, line):
           # parsear una URL o ID suelto y devolver el file_id, o None
           ...

       def download_url(self, file_id, proxies=None):
           # Si tu sitio tiene una URL de descarga fija/predecible, devolvela
           # directo (sin usar `proxies`), como pixeldrain.py.
           # Si hay que resolverla scrapeando una página o pidiendo una API
           # (porque expira o es de un solo uso), hacé esa request usando
           # el dict `proxies` que te pasan — se llama de nuevo en cada
           # intento, con el proxy de ese intento. Ver mediafire.py.
           return f"https://misitio.com/download/{file_id}"

       # opcionales: extract_folder_id, resolve_folder, request_headers,
       # expected_hash (sha256 para verificar integridad), check_size,
       # suggest_filename (si el nombre real no viene en un header HTTP),
       # postprocess (si hay que transformar/descifrar lo descargado antes
       # de que sea el archivo final — ver mega.py)
       #
       # Desde download_url podés levantar:
       #   FileUnavailable  -> el archivo no existe/fue borrado, corta ya
       #   RateLimited      -> este proxy está bloqueado/limitado AHORA por
       #                       el sitio (no está roto) — prueba con otro sin
       #                       blacklistearlo, ver fichier.py

   register(MiSitioProvider())
   ```

2. Importalo en `proxy_downloader/sites/__init__.py`:

   ```python
   from . import misitio  # noqa: F401
   ```

Con eso alcanza: la rotación de proxies, el resume, el chequeo de velocidad,
el modo batch y el modo carpeta ya funcionan solos para el sitio nuevo — todo
eso vive en `core/downloader.py` y no depende de ningún sitio en particular.

Siete ejemplos reales para copiar según tu caso:
- `proxy_downloader/sites/pixeldrain.py` — sitio simple, URL de descarga fija,
  proxy activado por defecto.
- `proxy_downloader/sites/mediafire.py` — sitio que necesita scrapear la
  página para conseguir el link real (y puede expirar), proxy desactivado por
  defecto, y usa `FileUnavailable` para cortar de una cuando el archivo fue
  borrado en vez de reintentar para siempre.
- `proxy_downloader/sites/mega.py` — sitio con cifrado del lado del cliente:
  usa `postprocess()` para descifrar lo descargado (AES-CTR) y verificar el
  MAC propio de Mega en vez de un hash simple, y `suggest_filename()` porque
  el nombre real viene cifrado dentro de la metadata, no en un header HTTP.
  Requiere `pycryptodome` (ya está en requirements.txt).
- `proxy_downloader/sites/fichier.py` — sitio con un countdown server-side
  antes de habilitar la descarga y un link final que necesita las cookies de
  la sesión que lo resolvió (por eso `request_headers()` puede depender de lo
  que `download_url()` dejó cacheado, se llama justo después en cada
  intento). Usa `RateLimited` para el caso "esta IP está bloqueada/CAPTCHA
  ahora" — distinto de `FileUnavailable`, porque acá el proxy no está roto,
  solo hay que probar con otro.
- `proxy_downloader/sites/gofile.py` — sitio donde `extract_file_id` y
  `extract_folder_id` aceptan el mismo id (la URL no distingue archivo de
  carpeta) y quien decide es `download_url`/`resolve_folder` según lo que
  diga la API; requiere una cuenta "guest" (token) más un segundo header
  anti-scraping calculado localmente, ambos cacheados en la instancia del
  provider y reusados en cada archivo.
- `proxy_downloader/sites/fileditch.py` — sitio con un desafío
  proof-of-work del lado del cliente (hashcash: SHA-256 con N bits en cero,
  resuelto en Python) antes de cada descarga, y el link real (firmado, con
  expiración) ofuscado en un array de JS que hay que reconstruir con regex
  en vez de un simple scrape de HTML — el ejemplo de "el link no está en un
  atributo, hay que parsear código".
- `proxy_downloader/sites/bunkr.py` — sitio que sobreescribe `owns()` en vez
  de listar dominios fijos (para aceptar cualquier mirror `bunkr.<tld>` sin
  mantenerla actualizada), pagina álbumes largos, y resuelve el link real en
  dos pasos encadenados (CDN → firma con token). También el ejemplo de por
  qué `folder_id` no puede ser una URL cruda: se usa como nombre de
  subcarpeta, así que tiene que ser algo sin `/` (acá, `"dominio:id"`).

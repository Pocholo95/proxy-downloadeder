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
    aria2.py                   wrapper del binario aria2c (descargas sin rotación de proxy)
    registry.py                registro de sitios + auto-detección por dominio
  sites/
    pixeldrain.py             sitio con URL de descarga estable (caso simple)
    mediafire.py               sitio que necesita resolver el link en cada intento (caso avanzado)
    mega.py                     sitio con descifrado del lado del cliente (caso avanzado+)
    fichier.py                   sitio con countdown server-side + cookies de sesión (caso avanzado)
    gofile.py                     sitio con cuenta guest + token anti-scraping (caso avanzado)
    fileditch.py                   sitio con proof-of-work + link firmado ofuscado en JS (caso avanzado)
    bunkr.py                        sitio con álbumes paginados + resolución de link en 2 pasos (caso avanzado)
    filester.py                      sitio con dos versiones de API — la vieja bloqueada, la v2 no (caso avanzado)
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
python downloader.py -F https://mega.nz/folder/XXXXXXXX#clave
python downloader.py -f https://1fichier.com/?XXXXXXXXX
python downloader.py -f https://gofile.io/d/XXXXXXX      # archivo suelto
python downloader.py -F https://gofile.io/d/XXXXXXX      # o carpeta — mismo link, se detecta solo
python downloader.py -f https://fileditchfiles.st/XXXXXXX/XXXXXXX/nombre.ext
python downloader.py -f https://bunkr.si/f/XXXXXXX        # archivo suelto (o /i/, /v/)
python downloader.py -F https://bunkr.si/a/XXXXXXX        # álbum — cualquier dominio bunkr.*, no solo .si
python downloader.py -f https://filester.me/d/XXXXXXX     # archivo suelto (o filester.gg)
python downloader.py -F https://filester.me/f/XXXXXXX     # carpeta
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
> - Mega sí soporta carpetas (`-F`/links `/folder/...#...`) — lista el
>   contenido con la API de carpetas de Mega (`n=` en vez de `p=`) y
>   descifra la clave de cada archivo con la clave de la carpeta; de ahí en
>   más cada archivo se descarga/descifra/verifica igual que uno suelto.
>   No preserva subcarpetas anidadas — todo cae en una sola carpeta de
>   salida, igual que Pixeldrain/Gofile/Bunkr/Filester.
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
> - **Filester** se había descartado en un primer intento: el endpoint de
>   descarga *v1* (`/api/public/download`) entrega un link detrás de
>   DataDome (WAF anti-bot comercial), no resoluble por cómputo local como
>   el proof-of-work de FileDitch. Encontramos que existe un endpoint *v2*
>   (`/v2/api/public/download`, mismo CDN pero forma de URL distinta) que
>   no pasa por ese bloqueo — verificado en vivo (HEAD, GET y Range, todos
>   con bytes reales, sin desafío) contra un archivo subido de verdad. El
>   listado de carpetas (`/f/<id>`, paginado) sale del mismo repo de
>   referencia pero no se pudo probar en vivo contra una carpeta real
>   (necesitaría una cuenta paga/registrada) — avisá si una carpeta de
>   verdad se porta raro.
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
Mega, Gofile y Filester lo usan por defecto (banean/limitan agresivo por IP
en su tier gratis/guest — para Filester no hay evidencia confirmada, pero
se optó por el lado cauteloso); Mediafire, FileDitch y Bunkr no — sus links
de CDN no están rate-limited de esa forma (el proof-of-work de FileDitch
frena scraping masivo, no una descarga puntual); 1fichier tampoco, pero por
otra razón: activamente bloquea IPs de datacenter/proxy (justo lo que son
los proxies gratis de esta lista). En un batch mixto, cada archivo usa el
modo de su propio sitio automáticamente — vas a ver `(proxy)` o `(direct)` en la
salida por cada uno.

**Velocidad mínima** (`--speed`, default 1500 KB/s): solo aplica cuando la
descarga va **con proxy** — si un proxy cae por debajo de eso, se
descarta y rota al siguiente. Sin proxy (`--no-proxy`, o un sitio con
`use_proxy_by_default = False`) no hay a qué rotar, así que este chequeo no
corre.

Ese mismo camino sin proxy es el que usa [aria2](https://aria2.github.io/)
como motor de descarga real (`proxy_downloader/core/aria2.py`) en vez de
una sola conexión `requests` — resume, verificación de integridad y
descarga por múltiples conexiones simultáneas, todo maneja aria2 solo
(control file `.aria2` al lado del `.part`, nada que este proyecto tenga
que llevar la cuenta a mano). El camino **con** proxy (`download_file`) se
queda en `requests`, porque aria2 no tiene forma de saltar a otro proxy a
mitad de una descarga como sí hace la rotación por velocidad de este
proyecto — por eso "aria2 en todo lo que se pueda, menos donde hay que
rotar proxy". Mismo motor para el endpoint del userscript de Violentmonkey
(nunca usa proxy) y, como downloader externo de yt-dlp, para la pestaña
"Video (yt-dlp)" cuando el modo de proxy es "Auto" o "Sin proxy" (con
"Forzar proxy" yt-dlp vuelve a su downloader nativo, ya que aria2 tampoco
puede rotar ahí). Requiere el binario `aria2c` (ya viene en el
`Dockerfile`; para correr la CLI local hace falta instalarlo aparte,
p. ej. `apt install aria2` / `brew install aria2`).

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

### Fuentes de proxy

Por defecto, el proxy viene de una **lista pública gratis** (URL en
`config.py`, texto plano, un `host:port` por línea) — se descarga, se
valida cada uno en paralelo, y se rota/descarta según ande. Ese sigue
siendo el comportamiento de fábrica, pero ahora es una de varias fuentes
posibles, configurables desde la sección **"Fuentes de proxy"** de la web
UI (o a mano en `config/proxy_sources.json`) — siempre hay exactamente
una **activa**, global para toda la app (no por descarga).

Dos tipos de fuente:

- **Lista pública**: como la de fábrica — cualquier URL que devuelva una
  lista de proxies en texto plano, uno por línea.
- **Gateway autenticado**: para proxies **pagos** tipo
  [Decodo](https://decodo.com/) (o cualquier proveedor con el mismo
  esquema: un endpoint fijo `host:puerto` + usuario/contraseña, donde la
  rotación de IP la hace el proveedor del lado de ellos, no acá). No hay
  nada que descargar ni validar — se arma una URL de proxy con las
  credenciales (`http://usuario:pass@host:puerto`) y se usa tal cual en
  cada descarga; nunca se descarta ni se banea localmente (no hay a qué
  más rotar de este lado, y una conexión nueva contra un gateway rotativo
  ya suele traer una IP de salida distinta por su cuenta). La contraseña
  se guarda en `config/proxy_sources.json` (gitignored) y la API/UI nunca
  la vuelve a mostrar una vez guardada.

```bash
curl -X POST http://localhost:8080/api/proxy-sources \
  -H "Content-Type: application/json" \
  -d '{"type":"gateway","name":"Decodo","host":"gate.decodo.com","port":10001,"username":"tu-usuario","password":"tu-contraseña"}'
```

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

La paleta/tipografía/tarjetas de la UI están tomadas del tema "classic"
(navy + sky-blue) de VidGrid, otro proyecto local — mismos tokens oklch,
mismo radio/sombras, traducidos a CSS plano en `static/style.css` ya que
esta UI no tiene build step (HTML+JS vanilla, sin React/Tailwind).

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

La sección "Archivos" es un mini explorador de `/downloads`: navegás
subcarpetas, bajás un archivo suelto o una carpeta entera (zip al vuelo),
**renombrás** (botón "✏ Renombrar", pide el nombre nuevo; rechaza `.`/`..`
y cualquier `/` que metas, así que nunca puede mover el archivo fuera de su
carpeta, y no deja renombrar una descarga `.part` en curso), borrás, y para
video/audio/imagen hay **preview in-browser** — click en el nombre abre un
reproductor con seek (soporta Range) sin descargar nada, `Esc` o click
afuera para cerrar.

Cada `.mp4`/`.m4v`/`.mov` tiene un botón **"🚀 Optimizar"**: hace
`ffmpeg -c copy -movflags +faststart`, un *remux* (no transcodifica —
copia los streams tal cual) que mueve el índice del archivo al principio
para que el navegador pueda arrancar a reproducir/buscar posición antes de
tener el archivo completo. Además, **todo video nuevo que termine de
descargarse por la web UI se optimiza solo** apenas cae al disco — el botón
manual es para lo que ya tenías descargado de antes. Requiere `ffmpeg` en
la imagen (ya viene en el `Dockerfile`); si no está disponible, el video
queda igual de bien, solo sin este empujoncito.

### Video (yt-dlp)

Cuarta pestaña de "Nueva descarga": pegás la URL de un video (o playlist)
de YouTube, Twitter/X, Instagram, TikTok, Reddit, Twitch y varios cientos
de sitios más que soporta [yt-dlp](https://github.com/yt-dlp/yt-dlp), y lo
descarga con el mejor video+audio disponible, mezclándolos a `.mp4` con
`ffmpeg` si hace falta. Incluye `curl_cffi` para que yt-dlp pueda
impersonar un navegador real cuando el sitio lo exige — varios sitios
devuelven `403 Forbidden` sin esto (se ve como "the extractor is
attempting impersonation, but no impersonate target is available" en el
log); no hace falta ninguna opción extra, yt-dlp lo detecta y lo usa solo.

Es un motor completamente aparte del descargador principal — no pasa por
los `SiteProvider` ni el proxy pool con rotación por velocidad — pero
reutiliza la misma carpeta de salida, el mismo desplegable de proxy y el
mismo pool/caché de proxies (`state/working_proxies.json`) para elegir uno.
La diferencia real es que acá **no hay rotación**: si elegís "Forzar
proxy" usa uno solo para toda la descarga (yt-dlp no tiene forma de
cambiarlo a mitad de camino como sí puede el motor principal); "Auto" y
"Sin proxy" bajan directo con la IP real. Por eso no tiene el campo de
velocidad mínima, que no aplica.

Tiene su propio historial ("Videos (yt-dlp)", persistido en
`state/ytdlp.json`) con progreso en vivo, log completo, cancelar y borrar
— mismo comportamiento que el resto: cancelar deja el `.part` en disco.
Todo video que termine de bajar se optimiza para streaming igual que
cualquier otra descarga (ver más abajo).

### Video (extensión) — userscript de Violentmonkey/Tampermonkey

Para páginas que ni yt-dlp (ni su extractor genérico) resuelve — sitios
sin extractor específico donde el video real se arma por JS recién al
reproducir, nunca aparece en el HTML plano. Mismo problema que resuelve
la extensión **Video DownloadHelper**, pero acá `extras/violentmonkey/
video-catcher.user.js` corre en **tu propio navegador real** mientras
mirás el video de forma completamente normal — no hay heurística de click
en un navegador headless adivinando dónde está el botón de play, porque
el que hace click sos vos.

Detecta por dos vías (cualquier `fetch`/XHR que la página dispare, y
cualquier `<video>` que aparezca en el DOM, incluso adentro de iframes de
otro origen — Violentmonkey inyecta el script en cada frame por separado,
así que no hace falta ir a buscar el iframe a mano) y, con un botón
flotante, manda la URL + `Referer`/`Origin`/`User-Agent` que se usaron de
verdad a `POST /api/extension/download`, que descarga directo — ya
elegiste vos, en la página, cuál video era.

Instalación: instalá [Violentmonkey](https://violentmonkey.github.io/) (o
Tampermonkey) en tu navegador, abrí
`extras/violentmonkey/video-catcher.user.js` desde este repo y confirmá
la instalación. Después, desde el menú de Violentmonkey en cualquier
página, **"⚙️ Configurar servidor"** una sola vez con la URL de tu
Proxy Downloader (tu hostname de Tailscale o `IP:puerto`). De ahí en más,
en cualquier página con video aparece un botón flotante abajo a la
derecha con la cantidad detectada — click, elegís cuál (o "todos"), listo.

No manda cookies (`document.cookie` no ve las `HttpOnly` de todos modos,
y ningún sitio verificado hasta ahora las necesitó — si alguno las
pidiera, se pueden sumar a mano en `sendToDownloader()` del script). Sin
auth en el endpoint, igual que el resto de la app — pero los headers que
manda el cliente se filtran igual del lado del servidor a la misma
lista chica (`Referer`/`Origin`/`User-Agent`/`Cookie`), nunca se reenvía
lo que sea que venga.

### Subir archivos

Es la tercera pestaña de "Nueva descarga" (junto a "Archivo / Carpeta" y
"Batch"): **Subir**. Marcás uno o más sitios destino —**Gofile**, **Bunkr**,
**Filester** y/o **FileDitch**— y sube el mismo archivo a todos los que
tildaste en un solo click; source es un archivo ya descargado (botón "⬆
Subir" en cada fila de "Archivos", que te lleva directo a esta pestaña con
el archivo ya elegido) o uno nuevo desde el dispositivo.

Bunkr y Filester requieren cuenta: al tildarlos aparece un bloque para
pegar el token (se verifica y se guarda en `config/<sitio>.json`, nunca se
vuelve a mostrar en la UI) y elegir o crear la carpeta/álbum destino — cada
sitio tildado tiene su propio bloque, así que podés mandar a distintas
carpetas en cada uno. Gofile tiene cuenta **opcional**: sin token sube como
invitado (link funciona igual, pero expira a los ~10 días de inactividad, y
la pestaña normal de Subir no te deja elegir carpeta sin cuenta — para eso
está "Subir carpeta", ver más abajo); cargando un token queda permanente y
con selector de carpeta, igual que Bunkr/Filester. FileDitch no tiene
cuentas ni carpetas: sube anónimo, cada archivo es un link suelto
independiente.

#### Subir carpeta

Cada fila de carpeta en "Archivos" tiene su propio botón **"⬆ Subir
carpeta"** (junto al de cada archivo suelto) — sube todo lo que hay adentro
(no recursivo) a los sitios que tildes, agrupado en **una sola carpeta
destino por sitio** en vez de que cada archivo termine desperdigado en su
propio link suelto. Trae un campo para el **nombre de la carpeta destino**
(precargado con el nombre de la carpeta local, editable) — se usa en
cualquier sitio donde no hayas elegido de antemano una carpeta ya
existente; donde sí elegiste una, esa elección manda y el campo no aplica.
Para un sitio con cuenta configurada, usa esa carpeta (existente o recién
creada con ese nombre) igual que una subida normal. Para Gofile **sin
cuenta**, arma sola una carpeta temporal anónima con ese nombre — crea una
cuenta invitada al vuelo (mismo mecanismo que ya usa cualquier subida
anónima a Gofile por debajo, solo que acá se pide explícitamente antes de
subir nada, para poder nombrarla y reusar esa misma cuenta invitada en los
N archivos) y sube todo ahí. Sin login en ningún momento — Bunkr/Filester
no tienen equivalente porque esos sí exigen cuenta real para tener
carpetas, punto.

El historial de "Subidas" agrupa por esta subida-de-carpeta (ícono 📁,
nombre = el de la carpeta local) en vez de por archivo individual como
hace normalmente — adentro, cada archivo muestra **su propio link** más
el link de la carpeta compartida (ambos funcionan de forma independiente
en Gofile, así que ninguno de los dos se pierde).

De dónde sale cada token:
- **Gofile**: perfil de tu cuenta en gofile.io (API token / account token).
- **Bunkr**: `dash.bunkr.cr/dashboard`, configuración de tu cuenta. La API
  del dashboard puede tener el alta pública cerrada según el momento
  (`enableUserAccounts`) — si no tenías cuenta previa, puede que el token no
  esté disponible todavía; con una cuenta existente debería andar igual.
- **Filester**: API key de tu cuenta en filester.gg/filester.me (a
  diferencia de Gofile y Bunkr, esta API sí está documentada oficialmente
  en `filester.gg/api-docs`, nada reverse-engineered de este lado).

Las subidas tienen su propio historial persistente (`state/uploads.json`,
"limpiar completados" igual que las descargas), con **progreso en vivo**
(bytes subidos / total, barra de progreso) mientras dura la subida, y una
vez que termina bien el link queda ahí con un botón de copiado rápido — no
se pierde entre recargas ni redeploys del contenedor. Si una falla (por
ejemplo un `502`/timeout del lado del sitio), el botón **"Reintentar"**
la vuelve a mandar tal cual (mismo sitio, mismo archivo, misma carpeta
destino) sin tener que elegir el archivo de nuevo — incluso si era uno
subido desde el dispositivo: ese archivo temporal no se borra hasta que
la subida termina bien, o hasta que borrás esa entrada del historial (si
reintentás y volvés a fallar, el archivo temporal "viaja" al intento más
nuevo, así que borrar un intento viejo del historial nunca compite por el
mismo archivo con uno que sigue vivo).

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
`POST /api/sites/<nombre>/proxy`,
`GET/POST /api/proxy-sources`, `POST /api/proxy-sources/<id>/activate`,
`DELETE /api/proxy-sources/<id>`, `GET/DELETE /api/files`,
`POST /api/files/rename`,
`GET /api/files/download`, `GET /api/files/preview`, `POST /api/files/optimize`,
`GET /api/uploads/sites`,
`POST/DELETE /api/uploads/account/<sitio>`, `GET/POST /api/uploads/folders/<sitio>`,
`GET/POST /api/uploads/jobs`, `GET/DELETE /api/uploads/jobs/<id>`,
`POST /api/uploads/jobs/<id>/retry`, `POST /api/uploads/folder-jobs`,
`POST /api/uploads/clear-finished`, `GET/POST /api/ytdlp/jobs`,
`GET /api/ytdlp/jobs/<id>`, `GET /api/ytdlp/jobs/<id>/log`,
`POST /api/ytdlp/jobs/<id>/cancel`, `DELETE /api/ytdlp/jobs/<id>`,
`POST /api/ytdlp/clear-finished`, `POST /api/extension/download`,
`GET /api/extension/jobs`, `GET /api/extension/jobs/<id>`,
`GET /api/extension/jobs/<id>/log`, `POST /api/extension/jobs/<id>/cancel`,
`DELETE /api/extension/jobs/<id>`, `POST /api/extension/clear-finished`)
es la misma que consume la página — se puede scriptear igual.

## VidGrid (incluido en la misma imagen)

La imagen también trae [VidGrid](vidgrid/README.md), un generador de
grillas de miniaturas/contact sheets para video (JPG estático, WebP/MP4
animado, modo secuencia, galería, soporte VR) con `ffmpeg` real — nada de
WASM, todo por CPU, sin GPU en juego en ningún lado. Es MIT, de un
proyecto de terceros (`aknott`), vendorizado bajo `vidgrid/` con dos
cambios propios respecto al original: su servidor solo escuchaba en
`127.0.0.1` con puerto efímero (pensado para desktop puro), y ahora lee
`VIDGRID_HOST`/`VIDGRID_PORT` para poder exponerlo igual que esta app; y
`webbrowser.open()` al arrancar ahora es opcional (`VIDGRID_NO_BROWSER=1`,
ya seteado en la imagen) para no tronar en un contenedor sin navegador.

Build multi-stage: un stage con Node arma su frontend (Vite/React) a
`dist/`, el stage final copia ese `dist/` + su backend Python (sin
dependencias más allá de la stdlib) y corre **dos procesos en el mismo
contenedor** vía `supervisord` (`supervisord.conf`) — gunicorn para esta
app, `python -m desktop.app` para VidGrid — cada uno en su puerto
(`8080`/`8090`, configurable por afuera con `WEB_PORT`/`VIDGRID_WEB_PORT`
igual que ya hacía este proyecto).

Comparte el volumen `/downloads` con esta app. Como su backend corre en
la misma máquina que los archivos (literal, mismo contenedor), la imagen
setea `VIDGRID_SHARED_DIR=/downloads`, que hace aparecer un botón
**"Browse /downloads"** en la pantalla principal (agregado propio, no
está en el VidGrid original — `/api/shared_dir` +
`nativeApi.getSharedDir()`; si esa variable no está seteada, el botón
simplemente no aparece, así que el desktop app original sigue andando
igual sin esto). Lo escanea/analiza en el filesystem sin tocar la red,
mismo mecanismo que ya usaba para uso desktop local ("la app y los
archivos están en la misma máquina") — y abre un **diálogo con
checkboxes** para elegir cuáles de los encontrados agregar, no los tira
todos de una (una carpeta compartida puede tener muchísimos videos
acumulados; nada se agrega hasta que elijas explícitamente cuáles).

También podés **subir un archivo desde tu dispositivo** para procesarlo
sin que quede permanentemente en `/downloads` — botón "Add videos…" o
arrastrar y soltar, igual que en el uso desktop normal (soporta elegir
varios de una, no hace falta el picker de carpeta nativo para eso). Esos
archivos suben a una carpeta temporal del contenedor y **se borran solos**
cuando terminás con esa tarea (la borrás de la lista, o resetea/reintenta)
— no antes tenían limpieza automática (quedaban hasta que el contenedor
se reiniciaba), lo arreglamos para que sea un uso realmente temporal:
`TaskSession.cleanup()` en `desktop/ffmpeg_runner.py` borra el archivo
subido solo si vive dentro del directorio de subidas del propio backend,
nunca si es un archivo escaneado por path (esos son tuyos, nunca se
tocan).

### Limpieza automática por inactividad

Corriendo 24/7, dos cosas se acumulan si nunca se limpian solas: cada
tarea (`TaskSession`, en `desktop/ffmpeg_runner.py`) crea una carpeta
temporal y una entrada en memoria que solo se liberaban si vos
explícitamente resetéabas/borrabas esa tarea — cerrar la pestaña sin
hacerlo las dejaba ahí para siempre; y cada archivo que previsualizás o
reproducís queda registrado en memoria (`/media/<token>` → path) sin
límite, tampoco.

Ahora un hilo en segundo plano barre cada `VIDGRID_SWEEP_INTERVAL_MINUTES`
(default 10) y limpia lo que no tuvo actividad en
`VIDGRID_IDLE_MINUTES` (default 60): tareas sin ninguna interacción (ni
un solo request de ffmpeg/lectura/escritura) en ese lapso, y tokens de
`/media/` sin ningún fetch. Nunca toca una tarea con un `ffmpeg` corriendo
en ese momento, sin importar cuánto tarde ese proceso — y una tarea con
un encode largo se sigue considerando "activa" mientras produce líneas
de progreso, así que un solo video grande no se corta a mitad de camino.
Poné `VIDGRID_IDLE_MINUTES=0` para desactivarlo del todo.

Mismo modelo de confianza que el resto de esta app: **sin autenticación**.
Su API (`/api/tasks/exec` en particular) corre `ffmpeg` con los argumentos
que arma el frontend — pensado originalmente para loopback únicamente, así
que si tu Traefik queda expuesto más allá de tu tailnet/LAN, la misma nota
de `ipallowlist` del `docker-compose.yml` aplica acá también.

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

Ocho ejemplos reales para copiar según tu caso:
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
- `proxy_downloader/sites/filester.py` — el mismo sitio puede tener más de
  un endpoint que hace básicamente lo mismo, y no ser equivalentes: la API
  vieja (v1) está bloqueada por un WAF comercial, la v2 no. Vale la pena
  buscar si hay una versión más nueva antes de descartar un sitio del todo.

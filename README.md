# Alma

Agente de escritorio con subagentes. Funciona con **Claude** (Anthropic) o
**Grok** (xAI), trabaja sobre una carpeta de tu computadora, delega en subagentes que corren en paralelo y
usa conectores **MCP**.

## Uso

```bash
pnpm install
pnpm run dev        # desarrollo con recarga en caliente
pnpm run build      # compila a out/
pnpm start          # corre lo compilado
pnpm test           # tests (vitest)
pnpm run typecheck
pnpm run check      # lint + typecheck + tests con cobertura (lo mismo que CI)
```

En la app, abrí **Configuración → Proveedores** y cargá tu API key de Anthropic, de xAI o de ambos.
También podés definir `ANTHROPIC_API_KEY`, `XAI_API_KEY` o `DEEPSEEK_API_KEY` en el entorno. Después creá una conversación,
elegí la carpeta de trabajo (📁) y escribí una tarea.

## Qué hace

| Función | Detalle |
|---|---|
| Proveedores | Claude vía SDK oficial (streaming, pensamiento adaptativo, caché de prompt, fallback ante rechazos) , Grok vía la API pública de xAI y DeepSeek vía su API compatible con OpenAI. Se elige por agente. |
| Herramientas | `read_file`, `list_dir`, `search_files`, `write_file`, `edit_file`, `run_command` (PowerShell en Windows). Todas confinadas a la carpeta de trabajo. |
| Aprobaciones | **Pedir aprobación**, **Auto-review** (un modelo revisor evalúa cada acción con tus instrucciones), **Permitir todo**, **Solo lectura**, y "Siempre permitir" por herramienta. Las lecturas nunca piden aprobación. |
| Agentes | Perfiles de agente editables (General, Investigador, Programador, Revisor, Grok, DeepSeek). El agente principal delega con `delegate_task`, y varias delegaciones corren en paralelo. Los subagentes no pueden volver a delegar. |
| MCP | Servidores locales (stdio) o remotos (HTTPS). Importa `mcp.json` con el formato estándar (`mcpServers`). Las herramientas aparecen como `mcp__servidor__herramienta`. |
| Imágenes | `generate_image` genera con xAI (por defecto) u OpenAI y guarda en `imagenes/`. Si no indicás modelo, usa el más nuevo que liste tu cuenta. |
| Biblioteca de imágenes | `compose_image` arma imágenes originales **sin modelo de imágenes** (sirve con DeepSeek o sin keys de xAI/OpenAI). Ver abajo. |
| Instagram | `instagram_publish` publica con la sesión que abrís en **Configuración → Instagram**: iniciás sesión en la página de Instagram dentro de la app. **Siempre** pide aprobación y muestra la imagen y el texto, aunque el modo sea "Permitir todo". El **modo de prueba** (activado por defecto) completa el post sin tocar "Compartir". |
| Rutinas y recordatorios | **Recordatorios** (solo avisan: notificación de Windows, aviso en la app que no se va hasta que lo cerrás, y Telegram si está conectado) y **rutinas** (un agente hace una tarea sola, en una conversación nueva). Pueden ser una sola vez, a una hora fija o cada N minutos/horas. Se crean en **Rutinas** o desde el chat («haceme acordar…»): los agentes tienen `create_reminder`, `create_routine` (pide aprobación), `list_routines` y `delete_routine`, y reciben la fecha y hora local. Incluye la plantilla "Post diario de Instagram". La app sigue en la bandeja del sistema. |
| Telegram | El bot corre dentro de Alma (long polling; sin servidor). En **Configuración → Telegram** cargás el token de @BotFather, los usuarios permitidos y qué agente responde. Solo acepta chats privados; el primer usuario permitido queda vinculado por id de chat. Cada chat es una conversación más en la barra lateral (/nuevo empieza otra), las aprobaciones llegan con botones Permitir / Rechazar, los audios se transcriben y los recordatorios llegan ahí. |
| Voz | Asistente de voz como el de ALMA, **sin Python**: palabra de activación (openWakeWord: «Hey Jarvis», «Alexa»…) o un atajo global, verificación de que sos vos (WavLM; en **Configuración → Voz** leés tres frases para entrenarla), transcripción con Whisper local u OpenAI, y respuesta hablada con Kokoro en español (espeak-ng), las voces de Windows o ElevenLabs (con selector de voces y muestras). Todo corre sobre onnxruntime en un hilo aparte y los modelos se descargan la primera vez. Las aprobaciones se responden por voz («¿sí o no?»). |
| Vault y conocimiento | Vista **Conocimientos** sobre una carpeta de `.md`: varios vaults, árbol de carpetas (crear, renombrar con F2, mover arrastrando, papelera), pestañas, editor con vista previa en vivo (CodeMirror 6), modo lectura e imágenes (`![[foto.png]]` incluido). Ctrl+O abre una nota, Ctrl+N crea otra, Ctrl+Shift+F busca y Ctrl+E alterna lectura/edición. El índice es SQLite (`node:sqlite`) con FTS5 y [sqlite-vec](https://github.com/asg017/sqlite-vec), y los embeddings son **bge-m3** int8 en CPU (unos 570 MB, se descargan la primera vez a `%APPDATA%\Alma\models`). La búsqueda combina BM25 y vectores con RRF. En cada mensaje los agentes reciben `Alma/Recuerdos.md` y los fragmentos más relevantes, y tienen `search_knowledge`, `read_note`, `save_knowledge`, `remember` y `forget`. Lo que guarda Alma queda en `Alma/` y se administra desde **Lo que sabe Alma**. |
| Domótica (Casa) | Sección **Casa**: el mapa de tu casa y los dispositivos (luces, enchufes, cámaras, parlantes, persianas, clima…), que manejás desde la app o pidiéndoselo a Alma por chat, voz, Telegram o WhatsApp. El motor es **Home Assistant**, que Alma instala y maneja sola dentro de un Linux oculto (WSL2, distro `alma-home`: baja ~1,2 GB, ocupa ~3 GB) o al que se conecta si ya tenés uno (URL + token). Marcas: Tuya/Smart Life (Moes), eWeLink/Sonoff (SonoffLAN, preinstalado), Tapo y ONVIF, Hue, Chromecast y todo lo que soporte Home Assistant: **Agregar dispositivo** dibuja los formularios de cada marca (cuenta, IP, QR) y los agentes hacen lo mismo con `home_add_device`. El **plano** es propio de Alma (2D cenital, las luces prendidas iluminan su habitación): se arma desde un dibujo de Excalidraw, una foto o croquis (visión) o a mano, y se edita arrastrando. Herramientas: `home_overview`, `home_find`, `home_control` (luces, enchufes, persianas, parlantes… sin pedir permiso), `home_secure_control` (cerraduras, alarmas y portones: siempre aprueba el usuario), `home_call_service`, `home_add_device`, `home_edit_device`, `home_remove_device`, `home_plan`, `home_plan_edit`, `home_plan_from_drawing`, `home_plan_from_image`, `look_at_image`, `camera_look`, `camera_watch`, `home_scene`, `home_modes`, `home_rules` e `home_history`. Las fotos se pegan o arrastran al chat (también llegan por Telegram). Reglas: las simples (horarios, «si hay movimiento prendé la luz») son automatizaciones de Home Assistant y no gastan IA; las que necesitan criterio despiertan a Alma con el evento («si la cámara del patio detecta movimiento de noche, mirá y avisame solo si es una persona»). Se configura en **Configuración → Casa**; cada persona conecta lo que tenga. Detalle en [docs/DOMOTICA-PLAN.md](docs/DOMOTICA-PLAN.md). |
| Empresas | Equipos de agentes: organigrama, tablero de tareas que despierta a los agentes, reuniones con preparación, presupuestos y aprobaciones del jefe al usuario. Sección **Empresas**. |
| WhatsApp | Alma vinculada a tu propio número como un dispositivo más (Baileys, protocolo no oficial): hablás con un agente en «Mensajes para mí» y los agentes pueden leer y escribir a contactos con aprobación. |
| Web y correo | Búsqueda en internet, lector de páginas que no llega a tu red local y correo IMAP/SMTP (buscar, leer, enviar). Enviar **siempre** pide aprobación. |
| Office y dibujos | Los agentes leen, crean y editan Word, Excel, PowerPoint y PDF reales, y dibujan diagramas Excalidraw dentro del vault. |
| Seguridad y privacidad | Secretos cifrados, confirmación nativa para ajustes riesgosos, registro de auditoría encadenado por hash, ventana blindada, bloqueo de redes privadas en las herramientas web y confinamiento de archivos. |
| Persistencia | Conversaciones en `%APPDATA%\Alma\threads`. La configuración va en `settings.json`, con las API keys cifradas con `safeStorage`. `ALMA_USER_DATA` usa otro perfil. |

## Bot de Instagram en 4 pasos

1. **Configuración → Proveedores:** cargá la key de Anthropic (texto) y la de xAI (imágenes).
2. **Configuración → Instagram:** tocá "Conectar Instagram" e iniciá sesión. La ventana se cierra sola.
3. En la carpeta de trabajo creá un `marca.md` con el tono, el público, los temas y lo que hay que evitar.
4. **Rutinas → Plantilla: post diario de Instagram.** Elegí la carpeta y el horario. Cuando el post esté listo te llega
   una notificación; lo revisás y tocás **Publicar** o **Rechazar**. Con el modo de prueba activado, mirá la ventana de
   Instagram y, si todo quedó bien (sobre todo los saltos de línea del texto), desactivalo.

> Instagram no permite automatizar acciones sin su autorización. Si detecta publicaciones automatizadas puede bloquear
> acciones o suspender la cuenta. Publicá poco. Si su página cambia, la publicación falla de forma controlada: la
> ventana queda abierta para terminar a mano.

## Biblioteca de imágenes

`compose_image` combina piezas en vez de pedirle la imagen a un modelo. El agente elige y Alma dibuja un SVG que el
proceso principal pasa a PNG sin conexión. Las dos versiones quedan en `imagenes/`: el PNG para publicar y el SVG
para editar.

| Pieza | Qué trae |
|---|---|
| Plantillas (12) | titular, cita, anuncio, promo, evento, lista, consejo, tarjeta, dividida, marco, abstracto, minimal |
| Paletas (16) | 4 por estética: minimalista, vibrante, elegante, orgánico |
| Fuentes (7, offline) | moderna (Outfit), geometrica (Space Grotesk), impacto (Bebas Neue), pop (Pacifico), elegante (Playfair Display), organica (Fraunces), manuscrita (Caveat) |
| Fondos (10) | sólido, degradado, radial, malla, puntos, cuadrícula, rayas, rayos, ondas, mitad, y grano opcional |
| Formas (22) | blob, círculo, anillo, ondas, puntos, destello, estrella, hoja, sol, confeti, corazón, rayo, luna… |

El texto se ajusta solo al espacio y a la vez se cuida el contraste, así que siempre se lee. Con la misma `seed` (semilla) sale
la misma imagen; cambiándola sale otra variante. El agente también puede sumar SVG propio con `svg_overlay`.

**Tus piezas.** Creá `biblioteca/` en la carpeta de trabajo:

```
biblioteca/
  logo.svg         # va solo en una esquina (también .png/.jpg/.webp)
  flor.svg         # cualquier SVG o imagen se usa por nombre como elemento ("flor"), o de fondo con photo
  MiFuente.ttf     # fuentes .ttf/.otf/.woff/.woff2, por nombre ("mifuente")
  paletas.json     # {"marca": {"background": "#14213d", "background2": "#1f3a6e", "text": "#ffffff", "accents": ["#fca311"]}}
```

Si hay paletas propias y no se pide otra, se usan esas. Si `marca.md` define colores o fuente, el agente los pasa.

**Piezas que toman color.** Un SVG de `biblioteca/` se dibuja dentro de la imagen, así que respeta el `color` del
elemento si usa `currentColor`, y el `color2` si usa `style="fill:var(--acento)"`. Las piezas propias tienen prioridad
sobre las formas incluidas que se llamen igual (por ejemplo, un `check.svg` propio reemplaza al check incluido).

**Recetas.** `biblioteca/recetas.json` guarda combos ya armados (plantilla, paleta, fuentes, fondo y piezas). El agente
pide `recipe: "promo"` y completa solo los textos; lo que pase además cambia la receta, y sus `elements` se suman.
Con `"decorations": false` no se dibujan las formas propias de la plantilla.

```json
{ "promo": { "template": "promo", "palette": "marca", "font": "mifuente", "decorations": false,
             "elements": [{ "type": "flor", "x": 0.8, "y": 0.2, "size": 0.3, "color": "texto", "color2": "acento" }] } }
```

## Qué hay en este repo

### Código (`src/`)

El renderer habla con el coordinador por un `MessagePort` directo, sin pasar por el proceso principal.

```
src/main/         proceso principal: ventana, bandeja, notificaciones, ajustes cifrados, guardas, navegador de Instagram
src/preload/      puente seguro (contextIsolation + sandbox): window.desktop
src/coordinator/  utilityProcess: lo que hace el trabajo
  agent.ts          loop del agente (neutral al proveedor), subagentes
  approval.ts       modos de aprobación y auto-review
  providers/        Anthropic, xAI (y DeepSeek / gateways compatibles con OpenAI)
  tools/            archivos, comandos, web, correo, imágenes, Office, rutinas, Telegram, WhatsApp, casa, empresas
  channels/         Telegram y WhatsApp
  knowledge/        índice SQLite (FTS5 + sqlite-vec), embeddings bge-m3, memoria
  company/          motor y almacén de empresas
  home/             domótica: Home Assistant, plano 2D, cámaras, reglas
  voice/            asistente de voz en JS (openWakeWord, STT, TTS) en un worker
  compose/          biblioteca de imágenes (compose_image)
  mcp.ts · routines.ts · images.ts · vision.ts · privacy.ts · store.ts
src/renderer/     UI en React (estilo consola)
  components/       chat, mensajes, tarjetas de herramientas, ajustes, rutinas, barra lateral
  vault/            notas Markdown, editor CodeMirror, dibujos, vista previa de documentos
  companies/ · home/ · voice/ · umbra/ (sistema de diseño) · lib/
src/shared/       tipos, protocolo y lógica pura que usan 2 o más capas
```

Reglas de capas (`shared` ← `main`, `coordinator`, `renderer`; nadie se importa de costado) y dónde va cada cosa: [docs/architecture.md](docs/architecture.md). Las hace cumplir `tests/architecture.test.ts`.

El loop del agente ([src/coordinator/agent.ts](src/coordinator/agent.ts)) es neutral respecto del proveedor. El historial es de solo-agregar y el contenido de Claude se reenvía sin tocar (con sus bloques de pensamiento firmados). Las entradas de herramientas se validan con Zod antes de ejecutarse. Si un turno se corta por límite de tokens o por un rechazo, sus herramientas no se ejecutan.

### Documentación (`docs/`)

| Dónde | Qué es |
|---|---|
| [docs/context.md](docs/context.md) | Glosario de términos del dominio ya resueltos |
| [docs/architecture.md](docs/architecture.md) | Procesos, capas y dónde va cada cosa nueva |
| [docs/desarrollo.md](docs/desarrollo.md) | Guía para instalar, correr, probar y extender Alma en Windows |
| [docs/pipeline.md](docs/pipeline.md) | Recorrido de una idea a producción y qué compuerta frena en cada tramo |
| [docs/modules/](docs/modules) | Un documento por módulo (chat, agentes, aprobaciones, providers, configuraciones, empresas, vault y conocimiento, Telegram, WhatsApp, Instagram, MCP, rutinas, voz, imágenes, Office, web y correo, casa, seguridad, app shell): qué hace, cómo se usa, cómo funciona |
| [docs/references/](docs/references) | Tablas de referencia escritas a mano contra el código: ajustes, datos en disco, herramientas, límites, mensajes IPC |
| [docs/adr/](docs/adr) | Decisiones de arquitectura (ADR 0001 a 0017) |
| [docs/security/](docs/security) | Controles (SOC 2 / ISO 27001 / 27701), privacidad y riesgos abiertos |
| [docs/DOMOTICA-PLAN.md](docs/DOMOTICA-PLAN.md) | Plan y estado del módulo de domótica |
| [SECURITY.md](SECURITY.md) | Cómo reportar una vulnerabilidad |

### Especificaciones (`.specify/`)

- `memory/constitution.md`: la constitución del proyecto. Si algo la contradice, gana ella.
- `specs/NNN-nombre/`: una carpeta por función con `spec.md`, `plan.md` y `tasks.md` (001 empaquetado, 002 chat, 003 agentes, 004 aprobaciones, 005 providers, 006 ajustes, 007 empresas, 008 vault, 009 conocimiento y memoria, 010 Telegram, 011 WhatsApp, 012 Instagram, 013 y 014 casa, 015 archivos y comandos, 016 web y correo, 017 MCP, 018 rutinas, 019 voz, 020 imágenes, 021 Office y dibujos, 022 seguridad, 023 app shell y UI). Cada criterio de aceptación cita el test que lo cubre, o está marcado `[gap]` (falta el test) o `[manual]` (se revisa a mano). Índice en [.specify/specs/README.md](.specify/specs/README.md).
- `templates/`: plantillas de spec, plan, tareas y guía para escribir la documentación.

### Tests (`tests/`)

Vitest. Cubren agente, herramientas, proveedores, MCP, Telegram, rutinas y horarios, conocimiento, empresas, casa, voz, medios, Office, web, auditoría y guardas. `architecture.test.ts` verifica las capas, `specs.test.ts` valida cada spec y `require-tests.test.ts` la política «si cambia la lógica, cambian los tests». `tests/fixtures/` trae un servidor MCP de eco y `tests/support/` los ayudantes de arquitectura y specs.

### Compuertas, hooks y CI

- `pnpm run check` = lint (Biome) + typecheck + tests con cobertura + política de tests, lo mismo que corre CI. `check:fast` es igual pero sin cobertura.
- `.githooks/` (se activan solos con `pnpm install`): `pre-commit` (lint de lo que está en stage), `commit-msg` (formato `tipo(área): resumen` y sin coautoría de IA) y `pre-push` (`pnpm run check`).
- `.github/`: workflow de CI (`quality`, `verify`, `audit`), Dependabot y plantilla de pull request.
- `scripts/`: `require-tests.mts` (exige tests cuando cambia lógica) y `hooks/` (lint tras cada edición y compuerta al terminar, para el agente).

### Agentes de IA para trabajar en el repo (`.claude/` y `.agents/`)

- `agents/`: `router` (decide el tamaño y la etapa), `planner` (specs), `implementer` (código, una tarea por vez), `tester` (verifica contra la spec) y `quality-checker` (calidad técnica).
- `commands/`: `/feature <idea>`, `/fix <bug>` y `/check`.
- `skills/`: modelado de dominio, entrevistas para aclarar specs y el sistema de diseño `umbra-ui` (copia en `.agents/skills/`).
- `settings.json`: hooks que corren los scripts de arriba. Reglas para agentes: [CLAUDE.md](CLAUDE.md).

### Otros

- `resources/`: íconos de la app y bandeja, y el modelo de palabra de activación (`wakewords/`).
- `package.json`, `pnpm-lock.yaml`, `electron.vite.config.ts`, `tsconfig*.json`, `biome.json`, `vitest.config.mts`: dependencias y configuración de compilación, tipos, lint y tests.

## Problemas comunes

- **La app no abre y aparece `Cannot read properties of undefined (reading 'whenReady')`**: la variable
  `ELECTRON_RUN_AS_NODE` está definida en tu terminal (pasa en algunas terminales de extensiones). Quitala
  antes de `pnpm run dev`.
- **"Falta la API key"**: cargala en Configuración → Proveedores.
- **Modelo de Grok**: si el campo queda vacío, se usa el Grok más nuevo que lista tu cuenta. Con ↻ podés
  traer la lista de modelos disponibles.
- **¿DeepSeek para imágenes?** Su API no genera imágenes: usá xAI u OpenAI, o la biblioteca de imágenes (`compose_image`), que no necesita ninguna.
- **Pruebas de la automatización de Instagram**: `ALMA_INSTAGRAM_URL` apunta la app a una página local que imita
  Instagram, para probar sin tocar una cuenta real.

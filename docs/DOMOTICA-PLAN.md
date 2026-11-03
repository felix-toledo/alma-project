# Plan: módulo de domótica ("Casa")

> Estado: **etapas 1 a 4 construidas y probadas** con un Home Assistant real (con el demo de HA) y con el motor instalado de cero. Falta lo que depende de tus dispositivos reales: ver «Para probar con tus dispositivos» al final. Las etapas de audio (parlantes y micrófonos por ambiente) quedan para cuando haya hardware.

## Lo que quedó construido (y en qué se aparta de este plan)

- **Motor**: Home Assistant 2026.10.1 en una distro WSL2 oculta (`alma-home`), exportada de la imagen oficial con `crane` (sin Docker) en ~7 minutos la primera vez. La cuenta del dueño la crea Alma sola y el token queda cifrado con el llavero del sistema. Modo externo (URL + token) también funciona.
- **Se probó de verdad**: instalación desde cero, arranque, creación de cuenta, apagado limpio, segundo arranque con la misma cuenta y desinstalación (`tests/home-live.test.ts`, con `ALMA_HOME_INSTALL=1`). Control de luces, escenas, automatizaciones, cámaras con visión, regla con criterio disparada por un cambio de estado, plano desde foto, desde Excalidraw y a mano.
- **Red espejada (mirrored)**: no se implementó. El descubrimiento automático en la red por mDNS no funciona en la red NAT de WSL: cada marca se agrega por su cuenta (Tuya, eWeLink) o por IP (Tapo), que es lo que se necesita para empezar.
- **Pisos de Home Assistant**: no se sincronizan; solo las habitaciones (áreas).
- **Modelo de visión**: se elige en Configuración → Casa; por defecto usa el del agente (o el primer agente con clave). Probado con DeepSeek Flash.
- **Reglas con criterio**: la cámara que piden (`camera_look`) ya está aprobada porque el usuario aprobó la regla al crearla.
- **Marcas personalizadas** (SonoffLAN) aparecen en la lista de marcas gracias a `integration/descriptions`.


## 1. Qué queremos

Una sección **Casa** en Alma donde:

- Le mostrás a Alma cómo es tu casa (dibujo en Excalidraw, foto de un plano o croquis, o fotos de cada ambiente) y Alma arma un **plano propio, profesional**, en 2D visto desde arriba.
- En ese plano viven los **dispositivos** de cada habitación: luces, enchufes, relés, cámaras, parlantes, micrófonos, sensores.
- **Todo se puede hacer de dos formas**: desde la app (botones, formularios, arrastrar) o pidiéndoselo a Alma ("agregá la cámara nueva al living", "renombrá el foco Moes a Luz de la cocina").
- Alma controla la casa por chat, voz, Telegram y WhatsApp: "prendeme la luz de la cocina", "¿qué se ve en la cámara del living?", "vigilá la puerta la próxima hora".
- Hay **modos** ("Noche", "Me fui", "Cine") y **disparadores** ("si hay movimiento de noche, prendé la luz y mandame una foto").

Dispositivos para probar: foco **Sonoff A19** (eWeLink), foco **Moes** (Tuya) y cámara **Tapo C200C** (TP-Link).

## 2. Decisiones tomadas

| Tema | Decisión |
|---|---|
| Motor | **Home Assistant (HA)** embebido. Corre en una distro **WSL2 oculta** que Alma instala, prende, configura y actualiza sola. Vos nunca ves HA. Si una PC no puede correr WSL, Alma se conecta a un HA que ya exista (URL + token). |
| Quién manda | **HA** es la fuente de verdad de dispositivos, entidades, áreas (habitaciones), pisos, escenas y automatizaciones. **Alma** es dueña del plano (geometría y posición de cada ícono) y de la inteligencia. |
| Marcas iniciales | Tuya (integración oficial de HA, se vincula con el QR de la app Smart Life), eWeLink (SonoffLAN, preinstalado), Tapo (a definir en la etapa 1: ver §8). Cualquier otra marca que soporte HA queda disponible desde "Agregar dispositivo". |
| Dónde corre | PC fija, siempre prendida, en la misma Wi-Fi que los dispositivos. Alma vive en la bandeja del sistema. |
| Plano | Excalidraw y las fotos son solo la **entrada**. La vista es un **plano 2D cenital propio** (SVG, estilo Umbra). Isométrico puede venir después. |
| Cámaras | Foto a pedido + visión, video en vivo en la app, movimiento como disparador y vigilancia con IA **por tiempo acotado**. Alma usa lo que corresponda según lo que pidas. |
| Reglas | **Mixto**: lo simple va como automatización de HA (confiable, no gasta tokens). Lo que necesita criterio despierta a Alma con el evento. |
| Permisos | Luces, enchufes, ventiladores, música y escenas: **libres**. Ver cámaras, vigilar, crear/borrar reglas, agregar/borrar dispositivos: **piden aprobación** (con "Siempre" disponible). Cerraduras, alarmas y portones: **siempre** piden aprobación. |
| Audio | Parlantes (Alma habla y pone música) y micrófonos por ambiente: el modelo de datos los contempla, se implementan cuando tengas alguno. |
| UI de HA | Oculta, con un botón "Abrir Home Assistant (avanzado)" en Configuración → Casa. |
| Orden | 1) motor + control → 2) plano y vista Casa → 3) cámaras → 4) modos y disparadores. |

## 3. Qué ya tiene Alma y se reutiliza

| Ya existe | Dónde | Cómo lo usa Casa |
|---|---|---|
| Sistema de herramientas con riesgo y aprobaciones (`read`/`write`/`exec`/`memory`/`publish`, "Siempre permitir", auto-review) | [src/coordinator/tools/types.ts](../src/coordinator/tools/types.ts), [src/coordinator/approval.ts](../src/coordinator/approval.ts) | Las herramientas `home_*` se registran igual que mail o WhatsApp en `appTools()` de [agent.ts](../src/coordinator/agent.ts). |
| Tarjeta de aprobación con imagen (`preview.imageDataUrl`) | [ToolCard.tsx](../src/renderer/src/components/ToolCard.tsx) | Mostrar la foto de la cámara en el chat. |
| Coordinator en `utilityProcess` + eventos en vivo al renderer | [src/coordinator/index.ts](../src/coordinator/index.ts), `LiveEvent` en [shared/types.ts](../src/shared/types.ts) | Cliente de HA (WebSocket) y estados en vivo hacia la vista Casa. |
| Rutinas y recordatorios (por horario) | [routines.ts](../src/coordinator/routines.ts), [tools/routines.ts](../src/coordinator/tools/routines.ts) | El "lanzar un agente en una conversación nueva" se reutiliza para los disparadores con criterio. |
| Telegram, WhatsApp, voz | `channels/`, `voice/` | Control por voz y por chat ya funciona porque son las mismas herramientas. Faltan las fotos (ver abajo). |
| Excalidraw en el vault (`excalidraw_read` / `excalidraw_draw`) y `describeDrawing` | [knowledge/tools.ts](../src/coordinator/knowledge/tools.ts), [shared/excalidraw.ts](../src/shared/excalidraw.ts) | Leer el dibujo de la casa que hiciste para convertirlo en plano. |
| Settings cifrados (`safeStorage`) y pestañas de Configuración | [main/settings.ts](../src/main/settings.ts), [SettingsDialog.tsx](../src/renderer/src/components/SettingsDialog.tsx) | Token de HA y contraseña del dueño. Pestaña nueva **Casa**. |
| Modos de la barra lateral (chat / vault / empresas) | [Sidebar.tsx](../src/renderer/src/components/Sidebar.tsx), [App.tsx](../src/renderer/src/App.tsx) | Cuarto modo: **Casa**. |
| Design system Umbra / consola | skill `umbra-ui` | Toda la UI nueva. |
| WebSocket nativo (Electron 44 → Node 24) | — | Cliente de HA sin dependencias nuevas. |

### Lo que falta y hay que construir

1. **Visión**: hoy los modelos **no reciben imágenes** (los bloques son texto, pensamiento y herramientas). Sin esto no hay "foto del plano → mapa" ni "¿qué se ve en la cámara?".
2. **Fotos en Telegram/WhatsApp**: hoy solo se manda y recibe texto (y audios en Telegram).
3. **Disparadores por evento**: las rutinas son solo por horario.
4. **Gestión de WSL** y todo el motor HA.
5. Vista Casa, plano, editor, panel de dispositivos, formulario para agregar dispositivos.

## 4. Arquitectura

```
┌──────────────────────── Alma (Electron) ────────────────────────┐
│ Renderer                                                         │
│  Vista Casa: plano SVG · panel de dispositivo · cámaras en vivo  │
│  "Agregar dispositivo" (formulario dinámico) · Modos y reglas    │
│  Configuración → Casa                                            │
│        ▲ eventos en vivo / requests                              │
│ Coordinator (utilityProcess)                                     │
│  home/hub.ts     cliente WebSocket + REST de HA, caché de estados│
│  home/plan.ts    plano (JSON) ↔ áreas y pisos de HA              │
│  home/triggers.ts disparadores con criterio → despiertan a Alma  │
│  tools/home.ts   herramientas home_* del agente                  │
│  vision.ts       "mirá esta imagen y respondé X"                 │
│        ▲                                                         │
│ Main                                                             │
│  home/engine.ts  instala / prende / apaga / actualiza la distro  │
└──────────────┬───────────────────────────────────────────────────┘
               │ http://localhost:8123 (REST + WebSocket)
┌──────────────▼──────── WSL2: distro "alma-home" ─────────────────┐
│ Home Assistant (+ go2rtc, ffmpeg)                                │
│ custom_components: SonoffLAN (+ Tapo Control si hace falta)       │
└──────────────┬───────────────────────────────────────────────────┘
               │ Wi-Fi / nube del fabricante
     Moes (Tuya)   ·   Sonoff A19 (eWeLink)   ·   Tapo C200C
```

### 4.1 Motor: Home Assistant dentro de WSL

**Cómo se instala** (opción preferida, a validar en la etapa 1):

1. Alma baja `crane` (binario único de Google para imágenes de contenedores, versión fijada) y exporta la **imagen oficial** `ghcr.io/home-assistant/home-assistant:<versión fijada>` (amd64) como un único `.tar`. No hace falta Docker.
2. `wsl --import alma-home %APPDATA%\Alma\home\vm <tar>`. Ese tar ya trae Python, HA, go2rtc y ffmpeg exactamente como los publica HA.
3. Alma copia los `custom_components` fijados por versión (SonoffLAN; Tapo Control si se elige) en `/config`.
4. Alma arranca HA como proceso hijo: `wsl.exe -d alma-home -- python3 -m homeassistant -c /config`. No usa el `/init` del contenedor.
5. **Onboarding automático** por API: crea el usuario dueño con contraseña aleatoria (guardada cifrada), saca un token de larga duración, define idioma, zona horaria y unidades, y desactiva la analítica.

- **Plan B**: distro Ubuntu mínima + `uv` + Python 3.14 + `pip install homeassistant` (la instalación "Core" documentada). Es más lenta y frágil.
- **Plan C**: HA externo (URL + token) para PCs sin WSL.

**Ciclo de vida**

- Prende con Alma y se apaga al salir de la app.
- Chequeo de salud cada 30 s, con reinicio automático.
- Pantalla "motor apagado / instalando / listo" en Configuración → Casa.

**Actualizar HA**

1. Exportar la versión nueva a una distro nueva.
2. Copiar `/config`.
3. Probar que arranca.
4. Cambiar y borrar la vieja.

Antes de actualizar se hace un backup con la API de HA.

**Red**

- Por defecto WSL usa NAT. Así funciona Tuya (nube), eWeLink (nube, y LAN cuando puede) y la Tapo por IP fija.
- El descubrimiento automático en la red (mDNS/SSDP) necesita el modo `mirrored` de WSL. Ese modo se configura en `%USERPROFILE%\.wslconfig` y **afecta a todas tus distros** (Ubuntu, docker-desktop).
- Por eso queda como un interruptor explícito en Configuración → Casa, apagado por defecto.

**Requisitos**: Windows 10/11 con WSL2 y virtualización activa. Unos 2 GB de disco y entre 300 y 600 MB de RAM.

### 4.2 Datos: qué guarda HA y qué guarda Alma

**HA** guarda:

- dispositivos, entidades y sus nombres;
- áreas (habitaciones) y pisos;
- escenas (modos);
- automatizaciones (reglas simples), etiquetadas `alma_*`.

**Alma** guarda en `%APPDATA%\Alma\home\plan.json`:

```jsonc
{
  "floors": [{
    "floorId": "planta_baja",            // = piso de HA
    "rooms": [{
      "areaId": "cocina",                // = área de HA
      "polygon": [[0,0],[420,0],[420,350],[0,350]],   // cm
      "doors": [{ "from": [120,350], "to": [200,350] }]
    }],
    "items": [{ "deviceId": "…", "entityId": "light.foco_moes", "x": 210, "y": 175, "icon": "bulb" }]
  }],
  "source": { "kind": "excalidraw" | "photo" | "manual", "path": "…" }
}
```

- Una habitación nueva crea un área en HA. Renombrar en un lado renombra en el otro.
- Un dispositivo que no está en el plano aparece en una bandeja "Sin ubicar".

Los **disparadores con criterio** de Alma van en `home/triggers.json`:

```jsonc
{ "id": "…", "when": { "entityId": "binary_sensor.tapo_motion", "to": "on" },
  "onlyBetween": ["22:00","07:00"], "cooldownMin": 10,
  "prompt": "Mirá la cámara del patio. Si hay una persona que no conocés, avisame por Telegram con la foto.",
  "agentId": "…", "enabled": true }
```

### 4.3 Visión (requisito transversal)

**`vision.ts`** expone `look(images, question) → texto`. Se configura un **modelo de visión** en Configuración → Proveedores: por defecto el del agente si acepta imágenes, y si no, uno elegido (Claude, Grok o el Vercel Gateway).

Se eligió así para no cambiar el formato de mensajes de todos los proveedores. Las herramientas que necesitan "ver" llaman a `look()` y le devuelven al agente el texto y la imagen para mostrarte en el chat.

Lo usan:

- `look_at_image(path, question)`: fotos que adjuntes en el chat, Telegram o WhatsApp, o del vault.
- `camera_look`: foto de la cámara + pregunta.
- La conversión de foto a plano: la visión devuelve el JSON de habitaciones.

### 4.4 Herramientas del agente

| Herramienta | Qué hace | Riesgo |
|---|---|---|
| `home_overview` | Pisos, habitaciones, dispositivos y estado actual (resumido). | read |
| `home_find` | Busca dispositivos por nombre, habitación o tipo ("las luces de arriba"). | read |
| `home_control` | Prender/apagar, brillo, color, volumen, play/pausa, activar escena. Solo luces, enchufes, interruptores, ventiladores, media y escenas. | **home** (nuevo: libre salvo en modo solo lectura) |
| `home_secure_control` | Cerraduras, alarmas, portones, cortinas motorizadas. | publish (siempre pregunta) |
| `home_call_service` | Llama a cualquier servicio de HA: la "puerta trasera" para manejar todo lo que HA sabe hacer. | write |
| `home_add_device` | Inicia el flujo de HA para una marca ("tuya", "sonoff", "onvif"…) y avanza paso a paso pidiéndote los datos que falten. Muestra QR o links cuando el flujo lo pide. | write |
| `home_edit_device` | Renombrar, cambiar de habitación, ocultar. | write |
| `home_remove_device` | Quitar de HA. | write |
| `home_plan_edit` | Crear/editar pisos, habitaciones (polígonos), puertas y ubicar dispositivos en el plano. | home |
| `home_plan_from_drawing` | Lee un `.excalidraw` del vault y propone el plano (rectángulos y textos → habitaciones). | home |
| `look_at_image` | Mira una foto (plano, croquis, ambiente) y responde. | read |
| `camera_look` | Saca una foto de una cámara y responde la pregunta ("¿hay alguien?"). | write |
| `camera_watch` | Vigila N minutos, cada X segundos, buscando algo concreto. Al aceptar muestra el costo estimado y se puede cortar desde el chat o la vista Casa. | write |
| `home_modes` | Crear/editar/borrar modos (escenas de HA). | write |
| `home_rules` | Crear/editar/borrar/activar reglas: simples → automatización de HA; con criterio → disparador de Alma. | write |
| `home_history` | "¿A qué hora se apagó la luz?", "¿hubo movimiento anoche?" | read |
| `home_speak` | (Cuando haya parlantes) Habla o reproduce en un parlante de la casa. | home |

`send_telegram` y `send_whatsapp` suman la opción de **adjuntar una imagen**.

### 4.5 UI

**Modo "Casa" en la barra lateral** (Umbra):

- **Plano**:
  - pestañas por piso;
  - habitaciones como polígonos con nombre;
  - las luces encendidas bañan la habitación con un halo cálido (color y brillo reales del foco);
  - íconos por tipo, y los apagados quedan atenuados;
  - las cámaras muestran una miniatura que se refresca.
- **Interacción**:
  - tocar un dispositivo lo prende o apaga;
  - mantener apretado o clic derecho abre su panel (brillo, temperatura, color, o video en vivo si es cámara);
  - navegación con teclado y gamepad, como el resto de Umbra.
- **Modo editar**: arrastrar dispositivos, mover vértices de habitaciones, agregar habitaciones, puertas, renombrar, bandeja "Sin ubicar".
- **Barra de modos**: los modos como botones grandes ("Noche", "Me fui").
- **"Agregar dispositivo"**:
  - buscador de marcas (todas las integraciones de HA);
  - un formulario que se arma solo con lo que pide HA (texto, contraseña, listas, QR, links externos);
  - al terminar, elegir la habitación y ubicarlo en el plano.
- **Reglas**: lista de reglas (las de HA y las de Alma) con interruptor, descripción en lenguaje natural y "creada por vos / por Alma". Al principio se crean conversando con Alma; un editor visual queda para más adelante.
- **Cámaras en vivo**: primero MJPEG (`/api/camera_proxy_stream`, es un `<img>`, cero código extra). WebRTC con go2rtc solo si la latencia o el uso de CPU molestan.
- **Configuración → Casa**:
  - estado del motor: instalar, reparar, reiniciar, actualizar;
  - red `mirrored` (opcional);
  - HA externo (URL + token);
  - backups;
  - "Abrir Home Assistant (avanzado)".

## 5. Historias de usuario

Formato: *Como [quién], quiero [qué], para [para qué].* Debajo de cada una, los criterios de aceptación (**CA**).

### E1 · Motor

- **H1.1** Como usuario, quiero que Alma instale el motor de domótica con un botón, para no tener que saber qué es Home Assistant.
  - CA: desde "Casa" sin motor aparece "Instalar motor".
  - CA: muestra el avance (descargando, importando, configurando).
  - CA: al terminar, HA responde en `localhost:8123` y Alma tiene token.
  - CA: si falta WSL, explica qué hacer (admin y reinicio) y lo lanza.
- **H1.2** Como usuario, quiero que el motor prenda y se apague con Alma y se recupere solo si se cae.
  - CA: se mata el proceso de HA y en menos de 1 minuto vuelve, sin intervención.
- **H1.3** Como usuario con un HA propio, quiero conectar Alma a él por URL y token.
- **H1.4** Como usuario avanzado, quiero abrir la interfaz de HA desde Configuración → Casa.
- **H1.5** Como usuario, quiero actualizar el motor sin perder mis dispositivos.
  - CA: después de actualizar siguen los mismos dispositivos, habitaciones, escenas y reglas.

### E2 · Dispositivos

- **H2.1** Como usuario, quiero agregar mi foco Moes desde la app escaneando el QR con Smart Life.
  - CA: la entidad aparece y se puede prender y apagar.
- **H2.2** Como usuario, quiero agregar mi foco Sonoff con mi cuenta eWeLink.
  - CA: mismo resultado que H2.1.
  - CA: se avisa que conviene una segunda cuenta de eWeLink con los dispositivos compartidos (ver §8).
- **H2.3** Como usuario, quiero agregar mi cámara Tapo C200C.
  - CA: se ve la foto y el video en vivo, y aparece el sensor de movimiento.
- **H2.4** Como usuario, quiero pedirle a Alma "agregá el foco Moes" y que me guíe ella.
  - CA: Alma usa `home_add_device`, me pide los datos que faltan en el chat y termina igual que H2.1.
- **H2.5** Como usuario o como Alma, quiero renombrar, cambiar de habitación o quitar un dispositivo.
  - CA: el cambio se ve en HA y en el plano.
- **H2.6** Como usuario, quiero agregar cualquier otra marca que soporte HA desde la misma pantalla.

### E3 · Control

- **H3.1** Como usuario, quiero decir "prendeme la luz de la cocina" (chat, voz, Telegram o WhatsApp) y que se prenda sin pedirme permiso.
- **H3.2** Como usuario, quiero "poné la luz del living al 30 % y cálida".
- **H3.3** Como usuario, quiero "¿qué luces quedaron prendidas?" y "apagá todo".
- **H3.4** Como usuario, quiero tocar un foco en el plano para prenderlo, y ver el estado real en vivo aunque lo cambie desde otra app.
- **H3.5** Como usuario, quiero que lo sensible (cerraduras, alarmas) siempre me pida confirmación, aunque esté en "Permitir todo".

### E4 · Plano

- **H4.1** Como usuario, quiero mandarle a Alma la foto de un plano o croquis y que arme las habitaciones.
  - CA: Alma propone el plano.
  - CA: lo veo en la vista Casa y lo puedo corregir antes de aceptar.
- **H4.2** Como usuario, quiero dibujar mi casa en Excalidraw y que Alma la convierta en plano.
- **H4.3** Como usuario, quiero mandarle fotos de cada ambiente para que Alma reconozca qué habitación es y qué hay (lámparas, TV, parlantes), y me pregunte cómo se conectan.
- **H4.4** Como usuario, quiero editar el plano a mano: mover paredes o vértices, agregar habitaciones y puertas, arrastrar dispositivos.
- **H4.5** Como usuario, quiero varios pisos.
- **H4.6** Como Alma, quiero leer el plano para entender "la luz de al lado de la puerta" o "la de arriba".

### E5 · Cámaras

- **H5.1** Como usuario, quiero preguntar "¿qué se ve en la cámara del living?" y recibir la respuesta con la foto.
  - CA: pide aprobación la primera vez, salvo que haya puesto "Siempre".
- **H5.2** Como usuario, quiero ver la cámara en vivo en la vista Casa.
- **H5.3** Como usuario, quiero "vigilá la puerta la próxima hora y avisame si llega un paquete", con costo estimado y la posibilidad de cortarlo.
- **H5.4** Como usuario, quiero que me llegue por Telegram la foto cuando una regla lo pida.
- **H5.5** (Si la cámara lo permite) Como usuario, quiero mover la cámara: "mirá hacia la ventana".

### E6 · Modos y reglas

- **H6.1** Como usuario, quiero crear un modo "Noche" (apagá todo menos el pasillo al 10 %) desde la app o pidiéndoselo a Alma, y activarlo con un botón o por voz.
- **H6.2** Como usuario, quiero reglas simples ("a las 23 activá Noche", "si hay movimiento en el pasillo de noche, prendé la luz 2 minutos") que funcionen sin gastar tokens.
  - CA: quedan como automatización de HA y se ven en la lista de reglas.
- **H6.3** Como usuario, quiero reglas con criterio ("si la cámara del patio detecta movimiento, que Alma mire y me avise solo si es una persona").
  - CA: el evento despierta a Alma con la foto.
  - CA: respeta la franja horaria y el cooldown.
  - CA: el gasto queda registrado.
- **H6.4** Como usuario, quiero ver, prender, apagar y borrar las reglas, sepa quién las creó.
- **H6.5** Como usuario, quiero preguntar "¿qué reglas hay?" y que Alma me las explique.

### E7 · Audio (más adelante)

- **H7.1** Como usuario, quiero que Alma hable por el parlante de la habitación donde estoy.
- **H7.2** Como usuario, quiero hablarle a Alma desde la cocina con un satélite de voz.
- **H7.3** Como usuario, quiero controlar la música.

## 6. Etapas

Cada etapa termina con una prueba con tus dispositivos reales y tu OK antes de seguir.

### Etapa 0 · Prueba de factibilidad del motor (½ día)

- Validar el camino `crane export` → `wsl --import` → HA arranca → onboarding por API.
- Medir tiempo, disco y RAM.
- Probar Tuya, SonoffLAN y la Tapo (oficial vs ONVIF vs Tapo Control) en NAT.
- **Sale**: el método de instalación confirmado (o pasamos al plan B) y la integración Tapo elegida.

### Etapa 1 · Motor + dispositivos + control por chat

- `main/home/engine.ts`: instalar, arrancar, salud, detener.
- `coordinator/home/hub.ts`: WebSocket, caché de estados, registros de áreas, dispositivos y entidades.
- Riesgo nuevo `home` en las aprobaciones.
- Herramientas: `home_overview`, `home_find`, `home_control`, `home_secure_control`, `home_call_service`, `home_add_device`, `home_edit_device`, `home_remove_device`.
- **Configuración → Casa**: estado, instalar, HA externo, abrir HA.
- **Vista Casa mínima**: lista por habitación con interruptores y "Agregar dispositivo" con el formulario dinámico.
- Historias: H1.1–H1.4, H2.1–H2.6, H3.1–H3.5 (H3.4 en la lista; en el plano llega en la etapa 2).

### Etapa 2 · Visión + plano + vista Casa

- `vision.ts` + `look_at_image`, y fotos entrantes de Telegram y WhatsApp.
- `plan.json`, sincronizado con áreas y pisos.
- `home_plan_edit`, `home_plan_from_drawing`.
- Vista de plano SVG con estados en vivo y modo editar.
- Historias: H4.1–H4.6 y H3.4 completa.

### Etapa 3 · Cámaras

- `camera_look`, `camera_watch` (con costo estimado y botón de cortar), video en vivo MJPEG y PTZ si existe.
- Imágenes en `send_telegram` y `send_whatsapp`.
- Historias: H5.1–H5.5.

### Etapa 4 · Modos y reglas

- `home_modes`, `home_rules`, automatizaciones `alma_*` en HA.
- `home/triggers.ts`: suscripción a eventos, franja horaria, cooldown, lanzar el agente, gasto.
- Panel de reglas y barra de modos.
- Historias: H6.1–H6.5, H1.5.

### Etapa 5 · Audio (cuando haya hardware)

- `home_speak`, music assistant, satélites de voz.
- Historias: H7.x.

## 7. Cómo voy a trabajar

- Rama `feat/domotica` desde `feat/alma-deepsek` (o `main`, como prefieras). Un commit por etapa o por parte coherente, sin línea de coautoría.
- **Antes de cada etapa**: leo el código que toca y valido lo dudoso con una prueba chica (la etapa 0 es eso para el motor).
- **Mientras programo**:
  - sigo el estilo del repo (comentarios en español, zod, `defineTool`, una función por archivo cuando alcanza);
  - nada de abstracciones para un solo caso;
  - **ninguna dependencia npm nueva prevista** (WebSocket nativo de Node 24, SVG a mano). Si alguna resulta inevitable, la fijo a una versión de más de 2 semanas.
- **Pruebas**:
  - `vitest` para la lógica pura: geometría del plano, mapeo de formularios de HA, si una regla aplica o no, conversión de Excalidraw a habitaciones;
  - `npm run typecheck`;
  - prueba de punta a punta en un perfil aislado (`ALMA_USER_DATA=<dir>`) con un modelo barato;
  - reinicio la app después de tocar el coordinator, porque `pnpm dev` no lo recarga.
- **Al cerrar cada etapa**: te muestro qué anda, con capturas, y qué quedó afuera. Actualizo este documento y el README.
- La UI la hago con el skill **umbra-ui**.

## 8. Riesgos y temas abiertos

| Riesgo | Mitigación |
|---|---|
| WSL no disponible en otras PCs (sin virtualización, Windows Home viejo). | Mensaje claro + opción HA externo. |
| El modo `mirrored` cambia la red de **todas** tus distros WSL. | Apagado por defecto. Solo hace falta para descubrir dispositivos solos; se puede agregar todo por IP o nube. |
| **Tapo C200C**: no está claro si la integración oficial de TP-Link de HA soporta esta cámara. La alternativa probada por la comunidad es [Tapo: Cameras Control](https://community.home-assistant.io/t/custom-component-tapo-cameras-control/231795) (personalizada; trae movimiento y PTZ) u [ONVIF](https://community.tp-link.com/en/smart-home/forum/topic/501994). | Se decide en la etapa 0. En todos los casos hace falta crear una **"cuenta de cámara"** en la app Tapo. |
| **eWeLink**: usar la misma cuenta en varios sistemas te desloguea. El autor de SonoffLAN [recomienda una segunda cuenta](https://gitee.com/dlcmirrors/SonoffLAN) con tus dispositivos compartidos. | Lo explicamos en el formulario. Vos creás la segunda cuenta. |
| **Tuya**: el foco tiene que estar en la app Smart Life o Tuya Smart (no solo en la app de Moes) para el QR. | Si está en la app Moes, se pasa a Smart Life antes. |
| HA es Python. Es una excepción a la regla "sin Python", pero queda aislado en WSL y no lo tocás. | — |
| HA cambia seguido y puede romper los componentes personalizados. | Versiones fijadas de HA y de los componentes. Se actualiza a propósito, con backup. |
| Vigilar con IA cuesta tokens (~1–1,6 mil tokens por foto). 1 foto por minuto durante 1 hora son ~60 fotos. | Siempre acotado en el tiempo, con costo estimado antes de aceptar, modelo de visión barato configurable, y solo dispara con movimiento si la cámara lo detecta. |
| La foto de un ambiente no dice cómo se conecta con los demás. | Alma pregunta, o se combina con el croquis. |
| La HA dentro de WSL depende de Alma: si cerrás Alma, la casa no corre reglas. | Alma queda en la bandeja. Es una PC siempre prendida. |

## 9. Qué necesito de vos para arrancar

1. **OK a este plan**, o los cambios que quieras.
2. Para la etapa 0/1:
   - poder crear una distro WSL nueva (`alma-home`, unos 2 GB);
   - el foco Moes en **Smart Life** y el *User Code* de la app (Yo → Configuración → Cuenta y seguridad → Código de usuario);
   - una **segunda cuenta de eWeLink** con el foco Sonoff compartido;
   - una **"cuenta de cámara"** en la app Tapo (Configuración de la cámara → Avanzado → Cuenta de cámara) y la **IP** de la C200C (ideal: IP fija en el router).
3. ¿Rama nueva desde `feat/alma-deepsek` o desde `main`?

## Para probar con tus dispositivos

Todo se hace desde Casa → Agregar dispositivo (o pidiéndoselo a Alma):

1. **Instalar el motor**: Casa → "Instalar el motor" (la primera vez baja ~1,2 GB y tarda unos 7 minutos).
2. **Moes (Tuya)**: el foco tiene que estar en la app Smart Life o Tuya Smart. Agregar → Tuya → el código de usuario (Ajustes → Cuenta y seguridad) → escanear el QR con la app.
3. **Sonoff (eWeLink)**: Agregar → Sonoff → usuario y contraseña. Conviene una segunda cuenta de eWeLink con el foco compartido (con la misma cuenta se desloguea de otros lados).
4. **Cámara Tapo C200C**: creá la «cuenta de cámara» en la app Tapo (Cámara → Ajustes → Avanzado) y poné una IP fija en el router. Agregar → TP-Link/Tapo, o ONVIF si preferís (IP, puerto 2020, esa cuenta).
5. **Plano**: Casa → Plano → desde un dibujo de Excalidraw, o pegá una foto del plano en el chat y pedile «armá el plano», o dibujalo a mano con «Editar plano».

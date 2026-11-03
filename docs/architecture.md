# Arquitectura de Alma

Qué piezas hay, qué puede hablar con qué, y dónde va cada cosa nueva. Las reglas de la sección 2 no son una guía: las hace cumplir `tests/architecture.test.ts` en cada `pnpm test`.

## 1. Procesos y capas

```
┌──────────── renderer (React) ─────────────┐        src/renderer
│  UI. Sin disco, sin red, sin node.        │
└───────────────┬───────────────────────────┘
        window.desktop (preload, tipado en shared/desktop-api.ts)
┌───────────────▼───────────────────────────┐
│  main (Electron)                          │        src/main + src/preload
│  ventanas, bandeja, settings, diálogos    │
│  nativos, sesión de Instagram             │
└───────────────┬───────────────────────────┘
        MessagePort: RequestEnvelope / CoordinatorMessage (tipados en shared/types)
┌───────────────▼───────────────────────────┐
│  coordinator (utilityProcess)             │        src/coordinator
│  agentes, herramientas, proveedores,      │
│  canales, conocimiento, domótica, voz     │
└───────────────────────────────────────────┘
   shared (src/shared): tipos, esquemas y funciones puras que usan 2+ capas
```

| Capa | Es dueña de | Nunca |
|---|---|---|
| `shared` | tipos, defaults, lógica pura compartida | importar otra capa |
| `renderer` | pantallas y estado de UI | importar `main`/`coordinator`, `electron`, `node:*`, `shared/audit` |
| `main` | ventanas, settings en disco, diálogos nativos, secretos (`safeStorage`) | importar `coordinator`/`renderer` |
| `coordinator` | todo lo que piensa o hace I/O para un agente | importar `main`/`renderer`; tocar `electron` fuera de `index.ts` |

Entre capas solo viajan mensajes tipados. Si dos capas necesitan lo mismo, va a `shared` (si es puro) o se manda un mensaje (si no).

## 2. Reglas que se verifican solas

Están en `tests/support/arch.ts` (`RULES`), cada una con un caso negativo en `tests/architecture.test.ts` para que no pasen vacías. Además Biome rechaza ciclos de imports (`noImportCycles`).

Para agregar una regla: nueva entrada en `RULES` + un fixture que la rompa en el test. Para aflojar una: hablarlo primero (Constitución II).

## 3. Cómo se escribe el código

**Núcleo funcional, cáscara imperativa.** La decisión vive en una función pura, exportada y con test; el I/O es una cáscara fina alrededor. Ejemplos: `src/main/guard.ts` (`newCommands`), `src/coordinator/tools/web.ts` (`isPrivateHost`, `htmlToText`, `parseDuckDuckGo`).

**Inyección de dependencias.** Una herramienta recibe lo que necesita por `ToolContext` / `Host` (carpeta de trabajo, settings, `signal`, vault, Telegram, WhatsApp, la casa). No importa singletons ni lee estado global. Es lo que permite al test pasarle un doble.

**Validar en el borde, confiar adentro.** Zod en: entradas de herramientas, mensajes IPC, settings leídos de disco, todo lo que viene de la red.

**Variación por estrategia.** Proveedores (`providers/`), canales (`channels/`): una interfaz y una implementación por caso, no un `if` creciente en quien llama.

**Estilo.** Igualá al código de al lado: sin punto y coma, comillas simples, identificadores en inglés, textos al usuario en español rioplatense, comentarios solo para el *por qué* no obvio. Biome avisa de lo evidente; no hay formateador automático todavía (ver deuda en `docs/pipeline.md`).

## 4. Dónde va lo nuevo

| Quiero agregar… | Va en | Y además |
|---|---|---|
| Una herramienta para agentes | `src/coordinator/tools/<nombre>.ts` exportando `ToolDefinition` (nombre, `risk`, esquema Zod, `run`) | registrarla donde se registran sus hermanas (`tools/index.ts` o `agent.ts`); elegir `risk` con cuidado (`publish` si actúa por el usuario hacia afuera); test en `tests/` |
| Un canal (como Telegram) | `src/coordinator/channels/` | aprobaciones y límites de usuario permitidos; entrada en `docs/security/` |
| Un proveedor de modelo | `src/coordinator/providers/` implementando `Provider` | test con proveedor falso, como `tests/providers.test.ts` |
| Un ajuste | tipo y default en `shared/types` y `shared/defaults`; lectura/escritura en `main/settings.ts`; pantalla en `SettingsDialog` | si ejecuta código nuevo, confirmación nativa (`main/guard.ts`) |
| Una pantalla | `src/renderer/src/<área>/`, con los skills `console-ui` y `umbra-ui` | la lógica con reglas a `shared/` + test |
| Una regla de negocio | función pura en `shared/` (o junto a la herramienta) | spec primero (Constitución I) |

## 5. Tests

- Viven en `tests/<área>.test.ts`; los dobles y utilidades compartidas en `tests/support/`.
- Se nombra el criterio que verifican: `it('AC-2.1 rechaza hosts privados', …)`. Así `tests/specs.test.ts` puede comprobar que cada AC de una spec `implemented` tiene test.
- Sistema de archivos: carpeta temporal por test (`mkdtempSync`) y limpieza en `afterEach`. Red: `vi.mock` del módulo, nunca internet real. Proveedores: el `Provider` falso de `tests/agent.test.ts`.
- Un test nuevo se ve fallar primero (Constitución III).
- El renderer no tiene tests de componentes: lo cubren typecheck, lint y una corrida manual. Por eso su lógica se saca a `shared/`.

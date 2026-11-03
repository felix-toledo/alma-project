# Pipeline: de pedir una feature a producción

Cómo trabajamos desde ahora. La autoridad es la [constitución](../.specify/memory/constitution.md); acá está el recorrido y qué compuerta frena en cada tramo.

Se arranca con `/feature <idea>` (o `/fix <bug>`). El agente `router` mira el estado real del repo y decide el camino.

```
 idea
  │
  ▼
router ──▶ ¿tamaño?
  │
  ├─ FEATURE  (comportamiento nuevo o cambiado, herramienta, canal, ajuste)
  │     Specify ─▶ Clarify ─▶ Plan ─▶ Tasks ─▶ Implement ─▶ Verify ─▶ PR ─▶ CI ─▶ main ─▶ Release
  │     planner    planner    planner  planner  implementer  tester ∥        humano
  │               +grill-with-docs                          quality-checker
  │        ▲ ─── humano aprueba la spec (`ready`) ───┘
  │
  ├─ FIX      (algo documentado o evidente no se cumple)
  │     test de regresión que FALLA ─▶ arreglo mínimo ─▶ Verify ─▶ PR … ─▶ + reforzar la compuerta que lo dejó pasar
  │
  └─ CHORE    (docs, dependencias, renombre sin cambio de comportamiento) ─▶ PR …
```

## Etapas

| # | Etapa | Quién | Produce | Qué la frena |
|---|---|---|---|---|
| 1 | Triage | `router` | camino elegido (feature / fix / chore) | — |
| 2 | Specify | `planner` | `.specify/specs/NNN-slug/spec.md` (`status: draft`) con historias, AC y reglas | plantilla incompleta |
| 3 | Clarify | `planner` + skill `grill-with-docs` | Open Questions respondidas; términos nuevos en `docs/context.md`; ADR si es difícil de revertir | **`tests/specs.test.ts`**: una spec `ready` con una pregunta abierta, o un `draft` con plan, falla |
| ◆ | **Compuerta humana 1** | vos | spec en `status: ready` | nadie avanza sin esto |
| 4 | Plan | `planner` | `plan.md`: capas tocadas, contratos, estrategia de test AC→test | reglas de capas (`docs/architecture.md`) |
| 5 | Tasks | `planner` | `tasks.md`: una tarea = un test que falla + código mínimo | — |
| 6 | Implement | `implementer`, una tarea por vez | test rojo → código → verde → refactor | hook al editar (Biome en el archivo), hook al terminar (`check:fast` si hubo cambios), `require-tests` |
| 7 | Verify | `tester` ∥ `quality-checker`, por separado | `tester`: veredicto por AC mirando solo la spec; `quality-checker`: arquitectura y limpieza mirando solo el código | los hallazgos vuelven a `implementer` |
| 8 | PR | vos / agente | rama `feat/…` o `fix/…`, commits `tipo(área): resumen`, plantilla de PR completa | pre-commit, commit-msg, pre-push (`pnpm run check`) |
| 9 | CI | GitHub Actions | `quality`, `verify` (y `audit` informativo) | cualquiera roja |
| ◆ | **Compuerta humana 2** | vos | merge a `main` | review; protección de rama (ver pendientes) |
| 10 | Release | ver spec [001](../.specify/specs/001-release-packaging/spec.md) | hoy: `pnpm run build` y tag a mano. Mañana: tag → instalador | — |

`tester` y `quality-checker` no se hablan ni leen el razonamiento del `implementer`: cada uno juzga solo desde su fuente, para que ninguno apruebe lo que el otro vio con cariño.

## Tamaños: cuándo NO hace falta spec

Un proceso que frena todo se abandona. Regla práctica:

- **Feature** si un usuario nota algo distinto o hay una regla que alguien podría discutir. Spec completa.
- **Fix** si el comportamiento contradice algo ya documentado o es obvio. Sin spec: test que falla, arreglo, y nombrar la compuerta reforzada (Constitución II). Si el bug muestra que faltaba una regla escrita, se abre una spec aparte.
- **Chore**: sin spec ni test nuevo.

Ante la duda, `router` pregunta una vez y elige el camino más corto que no adivine una regla de negocio.

## Compuertas (sensores) y dónde corren

| Compuerta | Qué atrapa | Al editar | Al terminar el agente | Commit | Push | CI |
|---|---|:-:|:-:|:-:|:-:|:-:|
| Biome (`pnpm run lint`) | bugs, imports sin uso, ciclos, promesas sin esperar | archivo | ✔ | staged | ✔ | ✔ |
| `tsc` (`pnpm run typecheck`) | tipos, incluidos los tests | | ✔ | | ✔ | ✔ |
| Vitest (`pnpm run test`) | comportamiento + **arquitectura** + **specs** | | ✔ | | ✔ | ✔ |
| Cobertura (`test:coverage`) | piso que solo sube | | | | ✔ | ✔ |
| `require-tests` | lógica cambiada sin test cambiado (`[no-tests: motivo]` para excepciones) | | | | ✔ | ✔ (PR) |
| `commit-msg` | formato `tipo(área): …`; sin `Co-Authored-By` de Claude | | | ✔ | | |
| `build` | que compile y empaquete | | | | | ✔ |
| `audit` | dependencias vulnerables | | | | | informativo (R-01) |

"Silencio si pasa, ruido si falla": las compuertas verdes no imprimen nada; las rojas devuelven el error al agente para que se corrija solo. Si el agente se queda rojo 3 veces seguidas con el mismo cambio, deja de bloquear y te avisa (evita bucles).

Comandos: `pnpm run check` (todo), `pnpm run check:fast` (sin cobertura), `pnpm run lint`, `pnpm run test`.

## Definición de terminado

1. Spec `implemented`: con `plan.md` y `tasks.md`, cada AC cita su test (o es `[manual]` con cómo se verifica, o `[gap]` si todavía no tiene), sin Open Questions, tareas tildadas.
2. `pnpm run check` verde.
3. `tester` y `quality-checker` informaron sin hallazgos abiertos.
4. Si tocó seguridad o privacidad: `docs/security/` actualizado en el mismo PR.
5. CI verde y revisado por vos.

## Guías, sensores y compuertas humanas (por qué existen)

- **Guías** (antes de actuar): constitución, `CLAUDE.md`, agentes con herramientas mínimas (`router`, `planner` y `quality-checker` no escriben código), plantillas, skills.
- **Sensores** (después de actuar): la tabla de arriba. Cuando una regla en prosa se rompe dos veces, se convierte en sensor (así nacieron `architecture.test.ts` y `specs.test.ts`).
- **Compuertas humanas**: solo donde lo hecho es caro de deshacer — aprobar la spec y mergear.

## Deuda conocida (a propósito, con trinquete)

- **548 avisos de Biome** (accesibilidad del renderer, `!` no nulos, comas): no bloquean, pero los errores sí. Se bajan de a poco; `biome.json` nunca se afloja.
- **Sin formateador**: 141 archivos no están formateados de forma uniforme; pasar Biome format en un commit aparte y recién ahí sumarlo a `check`.
- **Cobertura ~54 %** de líneas en `coordinator`/`shared`/`main`; el piso está en `vitest.config.mts` y solo sube. El renderer no tiene tests de componentes.
- **Release** sin empaquetar: spec 001, en `draft`.

## Pendientes que solo se hacen en GitHub

- Proteger `main`: exigir PR, y los checks `quality` y `verify`; prohibir push directo.
- Completar el correo de seguridad en `SECURITY.md`.

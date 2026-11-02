# Alma — instrucciones para agentes

App de escritorio Electron (Windows): agentes con herramientas locales, canales (Telegram, WhatsApp, voz), vault de conocimiento y domótica. Glosario: [docs/context.md](docs/context.md).

**La constitución manda**: [.specify/memory/constitution.md](.specify/memory/constitution.md). Si algo de acá la contradice, gana ella.

## Cómo se trabaja

SDD + test primero para la lógica. Recorrido completo y compuertas: [docs/pipeline.md](docs/pipeline.md). Capas y dónde va cada cosa: [docs/architecture.md](docs/architecture.md).

- Feature → `/feature <idea>`: spec → clarificar → plan → tareas → implementar → verificar. No se adivina ninguna regla de negocio: va a Open Questions.
- Bug → `/fix <bug>`: test que falla, arreglo mínimo, y reforzar la compuerta que lo dejó pasar.
- Chore (docs, deps, renombre sin cambio de comportamiento): directo.
- Agentes en `.claude/agents/`: `router`, `planner`, `implementer`, `tester`, `quality-checker`. Specs en `.specify/specs/`.

## Comandos

```bash
pnpm run check        # lint + typecheck + tests con cobertura + política de tests (lo mismo que CI)
pnpm run check:fast   # sin cobertura (lo que corre el hook al terminar)
pnpm run lint         # Biome
pnpm run test         # Vitest (incluye arquitectura y specs)
pnpm run dev          # app con recarga
```

- **pnpm siempre.** Nunca `npm install` ni `npm audit fix`: rompen `node_modules`. Si pnpm falla por archivos bloqueados, cerrar Alma y el editor.
- Nunca `--no-verify`, ni `biome-ignore` sin motivo escrito, ni bajar un umbral (Constitución II).
- Commits `tipo(área): resumen` (feat, fix, refactor, test, docs, chore, ci, perf, build). **Sin** `Co-Authored-By` de Claude.

## Reglas cortas

- Capas: `shared` ← `main`, `coordinator`, `renderer`; nadie se importa de costado. `electron` solo en `main/` y `coordinator/index.ts`. Lo verifica `tests/architecture.test.ts`.
- Lógica nueva = test nuevo, visto fallar antes. Cada AC de una spec se nombra en un test (`AC-1.1`).
- Toda herramienta declara su `ToolRisk`; lo que actúa hacia afuera en nombre del usuario es `publish` (siempre pregunta). Dudas de riesgo → Open Question.
- Secretos solo cifrados (`safeStorage`); nunca en logs, errores, fixtures ni prompts.
- Cambios de seguridad o privacidad actualizan `docs/security/` en el mismo PR.
- UI: cargar los skills `console-ui` y `umbra-ui` antes de tocar JSX o CSS.
- Estilo: igualar al código vecino (sin `;`, comillas simples, identificadores en inglés, textos al usuario en español rioplatense, comentarios solo para el porqué).

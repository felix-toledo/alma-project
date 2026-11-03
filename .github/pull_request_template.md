## Qué y por qué
<!-- Una o dos líneas. Link a la spec si es una feature: .specify/specs/NNN-slug/spec.md -->

## Camino del pipeline
- [ ] **Feature** — spec `NNN-slug` en estado `ready`/`implemented`, sin Open Questions
- [ ] **Fix** — test de regresión que fallaba antes del arreglo (Cláusula II)
- [ ] **Chore/docs** — sin cambio de comportamiento

## Verificación
- [ ] `pnpm run check` verde en local
- [ ] Cada AC de la spec está nombrado en un test (`AC-n.n`)
- [ ] `tester` (contra la spec) y `quality-checker` (contra la arquitectura) corrieron por separado
- [ ] Si toca seguridad/privacidad: actualicé `docs/security/CONTROLES.md` / `RIESGOS.md`
- [ ] Si no hay test: lo justifiqué con `[no-tests: motivo]` abajo

<!-- Compuerta rota que dejó pasar esto (Cláusula II): ¿qué gate reforzaste? -->

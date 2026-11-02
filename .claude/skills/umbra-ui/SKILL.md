---
name: umbra-ui
description: Design system estilo consola PlayStation/PS5 (oscuro, glass, halo de foco, bokeh ámbar, navegación por teclado y gamepad, ganchos de sonido). Usar en CUALQUIER trabajo de UI - crear o rediseñar botones, toggles, sliders, radios, checkboxes, selects, tabs, menús, tiles, modales, toasts, tooltips, progress/spinner/skeleton, hints de controles, reloj, fondo animado. Aplica también cuando el usuario dice "estilo consola", "estilo PS5", "que los botones tengan el diseño", "foco espacial", "sonidos de UI". Es un sistema de COMPONENTES; no incluye pantallas (bienvenida, selector de usuario) salvo que se pidan.
---

# Umbra · design system estilo consola

Inspirado en el menú de una consola moderna, **no una copia**: sin logos, tipografías ni assets de terceros.
Sensación: premium, silenciosa, fluida; se navega con control/teclado además de mouse.

## Alcance

El pedido es que **los componentes** (botones, controles, menús, overlays, feedback) tengan este diseño y
comportamiento. No armar pantallas completas, showcase, bienvenida ni selector de usuario salvo que se pidan.
Si la app ya existe, **re-temática la app existente** (ver "Aplicar a una app existente"), no crees una paralela.

## ADN visual

- Fondo: degradado azul-negro + haz de luz difuso arriba-izquierda + partículas bokeh ámbar flotando muy lento (40-100 s).
- Superficies: **glass** (translúcido, `backdrop-filter`, borde de 1px a baja opacidad). Nunca fondos opacos ni sombras duras.
- Foco = **halo**: anillo claro + escala `1.06` + glow azul. Los vecinos del enfocado bajan a opacidad `.55`.
- Hover y foco se ven **idénticos**. Active = `scale(.97)`.
- Tipografía: Outfit (OFL, `@fontsource-variable/outfit`), pesos 200-500, mucho aire.
- Layout: espacio negativo, listas verticales ícono+texto, reloj arriba-derecha, ControlHints abajo-derecha.

## Tokens (fuente de verdad: `assets/tokens.css`)

| Grupo | Tokens |
|---|---|
| Fondo | `--bg-base #05070d`, `--bg-elevated #0b1020`, `--bg-glow #12204a` |
| Glass | `--surface-glass .06`, `-hover .11`, `-active .16` (blanco), `--border-glass .12`, `--border-strong .28` |
| Texto | `--text-primary #f2f5fb` (17:1), `--text-secondary #a3adc2` (8.6:1), `--text-disabled #667088` |
| Acento | `--accent #5b9bff` (texto/iconos/halo), `--accent-solid #2f6bff` (rellenos con texto blanco, 4.6:1), `--accent-warm #ffb347`, `--focus-ring #e8f0ff` |
| Estado | `--success #4ade80`, `--warning #fbbf24`, `--danger #ff6b6b` |
| Tipografía | display 72, title 32, heading 22, body 17, caption 14 px · pesos 200/300/400/500 |
| Espaciado | base 4/8: 4 8 12 16 24 32 48 64 |
| Radios | pill 999, card 20, sm 12, círculo 50% |
| Glass | blur 18 (modal 32), dim 0.55, disabled 0.4, borde 1px, **touch mínimo 44px** |
| Elevación | solo glow: `--glow-soft`, `--glow-focus`, `--glow-warm` |
| Motion | 120 / 200 / 320 / 500 ms · `--ease-out` cubic-bezier(.215,.61,.355,1) · `--ease-spring` cubic-bezier(.34,1.4,.64,1) |

Usar siempre variables; nunca hex sueltos en componentes.

## Reglas de componente (todos)

1. **Estados obligatorios**: default, hover, focus, active, disabled, loading (`aria-busy` + spinner).
2. Navegable: `data-focusable` (o botón/link nativo). Mínimo 44×44 px.
3. Disparar el evento de sonido correspondiente (tabla abajo).
4. Rol/ARIA correcto: `switch`+`aria-checked`, `checkbox`, `radiogroup/radio`, `slider`+`aria-valuenow`, `listbox/option`, `tablist/tab`, `dialog aria-modal`, `progressbar`, `tooltip`+`aria-describedby`, `role=status` en toasts.
5. Color heredado (`currentColor`); contraste AA mínimo. Texto sobre `--accent-solid` es blanco; sobre `--accent` no se pone texto.
6. Animar solo `transform`/`opacity`. Todo respeta `prefers-reduced-motion` y el ajuste propio `html[data-motion='reduced']`.

Catálogo de referencia en `assets/components/` (React + Tailwind v4 + Framer Motion): `Button` (primary / secondary / ghost / icon / circle), `Toggle`, `Checkbox`, `RadioGroup`, `Slider`, `Select`, `Field`, `Tabs`, `MenuList`, `Tile`, `Modal`, `ToastProvider`/`useToast`, `Tooltip`, `ProgressBar`, `Spinner`, `Skeleton`, `ControlHints`, `SystemClock`, `Backdrop`. Copiarlos y adaptar; no reescribir desde cero.

## Íconos

- Lucide (`lucide-react`), wrapper `Icon` en `assets/icons/Icon.tsx`: **md 24px por defecto**, sm 20, lg 32, `strokeWidth 1.75`, color heredado. El ícono activo se ilumina (hereda el color del texto enfocado).
- Botones de control (`BtnCross`, `BtnRing`, `BtnTriangle`, `BtnSquare`): SVG propio simple, no los símbolos oficiales.
- `SETTINGS_ICONS`: storage→HardDrive, sound→Volume2, display→Monitor, accessories→Gamepad2, notifications→Bell, captures→Camera, network→Network, users→Users, accessibility→Accessibility, privacy→ShieldCheck, appearance→Sparkles, power→Power, debug→Bug, general→Settings.

## Navegación (`assets/nav/FocusManager.tsx`)

- `FocusProvider` una vez en la raíz: flechas, Enter, Esc y **Gamepad API** (D-pad / stick izq., A = Enter, B = atrás). Foco espacial por geometría (penaliza desvío lateral).
- `FocusScope id trap?`: recuerda el último foco; con `trap` (modal, select abierto) confina y devuelve el foco al cerrar.
- `useBack(fn, active)` escucha Esc/B. Controles que usan ←→ (slider) llevan `data-consumes-lr`.
- No secuestra flechas dentro de `input[type=text]` / `textarea`.

## Sonido (`assets/sound/`) — solo ganchos, sin audios

- `useUISound()` → `{ play, muted, setMuted, volume, setVolume }`; `playUISound(evento)` fuera de React.
- Eventos: `hover`, `focus-move`, `select`, `back`, `toggle-on`, `toggle-off`, `open-modal`, `close-modal`, `error`, `success`, `notification`, `page-transition`.
- `sounds.config.ts`: por evento `{ src: '' , volume, cooldown }` (hover 80 ms, focus-move 60 ms). `src` vacío = silencio.
- No suena hasta la primera interacción; respeta mute/volumen globales (guardados en localStorage).
- Cada componente dispara el suyo: Button/Tile/Menu → `select` + `hover`; Toggle → `toggle-on/off`; Modal → `open/close-modal`; Toast → `notification/success/error`; Tabs → `page-transition`; mover foco → `focus-move`.

## Motion

Foco: scale 1→1.06 + glow + vecinos a .55 (CSS, `base.css`). Pantallas: fade + desplazamiento 12px, 320 ms `--ease-out`. Modal: spring leve. `MotionConfig reducedMotion="user"` en la raíz.

## Fondo reutilizable

`<Backdrop reduceMotion />` (`assets/components/Backdrop.tsx` + clases `.umbra-bg/.umbra-beam/.umbra-bokeh` de `base.css`). Va primero en el árbol con `z-index:-1`; el contenedor raíz `position:relative; z-index:1`.

## Archivos de `assets/`

| Archivo | Uso |
|---|---|
| `tokens.css` | variables CSS (copiar tal cual) |
| `base.css` | foco/hover, dim de vecinos, reduce-motion, fondo, skeleton, `.glass` |
| `tailwind-theme.css` | `@theme inline` que expone los tokens como utilidades Tailwind v4 (`bg-glass`, `text-fg-2`, `rounded-card`…) |
| `plain-app.css` | adaptador para apps **sin** Tailwind: re-tematiza `button`, `input`, `.primary`, listas, modales existentes |
| `components/ nav/ sound/ icons/` | código de referencia |

## Aplicar a una app existente (sin Tailwind, p. ej. Electron + CSS plano)

1. `pnpm add lucide-react @fontsource-variable/outfit` (framer-motion solo si se usan los componentes con animación de React; para CSS plano alcanza con transiciones).
2. Copiar `tokens.css`, `base.css`, `plain-app.css` a la app e importarlos **después** de su CSS (en ese orden). Las variables viejas (`--bg`, `--text`, `--accent`…) quedan aliasadas a los tokens.
3. Quitar `@media (prefers-color-scheme: light)` si se quiere oscuro fijo. Reemplazar fondos opacos de sidebar/header/modal por glass.
4. Copiar `sound/` y `nav/`; montar `FocusProvider` en la raíz y `<Backdrop />` como primer hijo. El `FocusManager` ya reconoce botones y links nativos.
5. Reemplazar emoji de íconos (🔁 ⚙ ×) por `Icon` de Lucide.
6. Electron: `backgroundColor: '#05070d'` en la ventana. CSP: fuentes vía `@fontsource` quedan `'self'`; no hace falta tocarla.
7. Verificar mirando la app: foco con flechas, hover = foco, modal, `prefers-reduced-motion`.

## Stack para proyectos nuevos

React + TypeScript + Tailwind v4 (tokens como CSS variables + `tailwind-theme.css`), `lucide-react`, `framer-motion`, `@fontsource-variable/outfit`, Vite.

## Checklist antes de dar por terminado

- [ ] Todos los estados (incl. disabled y loading) y hover == focus.
- [ ] Teclado completo sin mouse; foco siempre visible; táctil ≥ 44px.
- [ ] Solo variables de token, sin hex sueltos; sin fondos opacos grandes.
- [ ] Íconos Lucide md/stroke 1.75; ControlIcons propios.
- [ ] Cada interacción llama al evento de sonido; sin audios incluidos.
- [ ] `prefers-reduced-motion` y mute respetados.

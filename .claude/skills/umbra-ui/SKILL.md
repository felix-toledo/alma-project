---
name: umbra-ui
description: PlayStation/PS5 console-style design system (dark, glass, focus halo, amber bokeh, keyboard and gamepad navigation, sound hooks). Use for ANY UI work - creating or redesigning buttons, toggles, sliders, radios, checkboxes, selects, tabs, menus, tiles, modals, toasts, tooltips, progress/spinner/skeleton, control hints, clock, animated background. It also applies when the user says "console style", "PS5 style", "make the buttons have the design", "spatial focus", "UI sounds" («estilo consola», «estilo PS5», «foco espacial», «sonidos de UI»). It is a COMPONENT system; it does not include screens (welcome, user picker) unless they are asked for.
---

# Umbra · console-style design system

Inspired by the menu of a modern console, **not a copy**: no third-party logos, typefaces or assets.
Feel: premium, quiet, fluid; it is navigated with a controller/keyboard as well as a mouse.

## Scope

The request is that **the components** (buttons, controls, menus, overlays, feedback) have this design and
behavior. Do not build full screens, a showcase, a welcome or a user picker unless they are asked for.
If the app already exists, **re-theme the existing app** (see "Applying it to an existing app"), do not create a parallel one.

## Visual DNA

- Background: blue-black gradient + a diffuse beam of light at the top left + amber bokeh particles floating very slowly (40-100 s).
- Surfaces: **glass** (translucent, `backdrop-filter`, a 1px border at low opacity). Never opaque backgrounds or hard shadows.
- Focus = **halo**: a light ring + scale `1.06` + blue glow. The neighbors of the focused element drop to opacity `.55`.
- Hover and focus look **identical**. Active = `scale(.97)`.
- Typography: Outfit (OFL, `@fontsource-variable/outfit`), weights 200-500, lots of air.
- Layout: negative space, vertical icon+text lists, clock at the top right, ControlHints at the bottom right.

## Tokens (source of truth: `assets/tokens.css`)

| Group | Tokens |
|---|---|
| Background | `--bg-base #05070d`, `--bg-elevated #0b1020`, `--bg-glow #12204a` |
| Glass | `--surface-glass .06`, `-hover .11`, `-active .16` (white), `--border-glass .12`, `--border-strong .28` |
| Text | `--text-primary #f2f5fb` (17:1), `--text-secondary #a3adc2` (8.6:1), `--text-disabled #667088` |
| Accent | `--accent #5b9bff` (text/icons/halo), `--accent-solid #2f6bff` (fills with white text, 4.6:1), `--accent-warm #ffb347`, `--focus-ring #e8f0ff` |
| State | `--success #4ade80`, `--warning #fbbf24`, `--danger #ff6b6b` |
| Typography | display 72, title 32, heading 22, body 17, caption 14 px · weights 200/300/400/500 |
| Spacing | base 4/8: 4 8 12 16 24 32 48 64 |
| Radii | pill 999, card 20, sm 12, circle 50% |
| Glass | blur 18 (modal 32), dim 0.55, disabled 0.4, 1px border, **minimum touch 44px** |
| Elevation | glow only: `--glow-soft`, `--glow-focus`, `--glow-warm` |
| Motion | 120 / 200 / 320 / 500 ms · `--ease-out` cubic-bezier(.215,.61,.355,1) · `--ease-spring` cubic-bezier(.34,1.4,.64,1) |

Always use variables; never loose hex values in components.

## Component rules (all of them)

1. **Mandatory states**: default, hover, focus, active, disabled, loading (`aria-busy` + spinner).
2. Navigable: `data-focusable` (or a native button/link). Minimum 44×44 px.
3. Fire the matching sound event (table below).
4. Correct role/ARIA: `switch`+`aria-checked`, `checkbox`, `radiogroup/radio`, `slider`+`aria-valuenow`, `listbox/option`, `tablist/tab`, `dialog aria-modal`, `progressbar`, `tooltip`+`aria-describedby`, `role=status` on toasts.
5. Inherited color (`currentColor`); AA contrast at least. Text on `--accent-solid` is white; no text is put on `--accent`.
6. Animate only `transform`/`opacity`. Everything respects `prefers-reduced-motion` and the own setting `html[data-motion='reduced']`.

Reference catalog in `assets/components/` (React + Tailwind v4 + Framer Motion): `Button` (primary / secondary / ghost / icon / circle), `Toggle`, `Checkbox`, `RadioGroup`, `Slider`, `Select`, `Field`, `Tabs`, `MenuList`, `Tile`, `Modal`, `ToastProvider`/`useToast`, `Tooltip`, `ProgressBar`, `Spinner`, `Skeleton`, `ControlHints`, `SystemClock`, `Backdrop`. Copy them and adapt; do not rewrite from scratch.

## Icons

- Lucide (`lucide-react`), `Icon` wrapper in `assets/icons/Icon.tsx`: **md 24px by default**, sm 20, lg 32, `strokeWidth 1.75`, inherited color. The active icon lights up (it inherits the focused text's color).
- Control buttons (`BtnCross`, `BtnRing`, `BtnTriangle`, `BtnSquare`): a simple SVG of our own, not the official symbols.
- `SETTINGS_ICONS`: storage→HardDrive, sound→Volume2, display→Monitor, accessories→Gamepad2, notifications→Bell, captures→Camera, network→Network, users→Users, accessibility→Accessibility, privacy→ShieldCheck, appearance→Sparkles, power→Power, debug→Bug, general→Settings.

## Navigation (`assets/nav/FocusManager.tsx`)

- `FocusProvider` once at the root: arrows, Enter, Esc and the **Gamepad API** (D-pad / left stick, A = Enter, B = back). Spatial focus by geometry (it penalizes lateral deviation).
- `FocusScope id trap?`: remembers the last focus; with `trap` (modal, open select) it confines focus and returns it on close.
- `useBack(fn, active)` listens to Esc/B. Controls that use ←→ (slider) carry `data-consumes-lr`.
- It does not hijack arrows inside `input[type=text]` / `textarea`.

## Sound (`assets/sound/`) — hooks only, no audio

- `useUISound()` → `{ play, muted, setMuted, volume, setVolume }`; `playUISound(event)` outside React.
- Events: `hover`, `focus-move`, `select`, `back`, `toggle-on`, `toggle-off`, `open-modal`, `close-modal`, `error`, `success`, `notification`, `page-transition`.
- `sounds.config.ts`: per event `{ src: '' , volume, cooldown }` (hover 80 ms, focus-move 60 ms). An empty `src` = silence.
- Nothing plays until the first interaction; it respects the global mute/volume (kept in localStorage).
- Each component fires its own: Button/Tile/Menu → `select` + `hover`; Toggle → `toggle-on/off`; Modal → `open/close-modal`; Toast → `notification/success/error`; Tabs → `page-transition`; moving focus → `focus-move`.

## Motion

Focus: scale 1→1.06 + glow + neighbors at .55 (CSS, `base.css`). Screens: fade + a 12px shift, 320 ms `--ease-out`. Modal: a light spring. `MotionConfig reducedMotion="user"` at the root.

## Reusable background

`<Backdrop reduceMotion />` (`assets/components/Backdrop.tsx` + the classes `.umbra-bg/.umbra-beam/.umbra-bokeh` of `base.css`). It goes first in the tree with `z-index:-1`; the root container `position:relative; z-index:1`.

## Files in `assets/`

| File | Use |
|---|---|
| `tokens.css` | CSS variables (copy as is) |
| `base.css` | focus/hover, neighbor dimming, reduce-motion, background, skeleton, `.glass` |
| `tailwind-theme.css` | `@theme inline` that exposes the tokens as Tailwind v4 utilities (`bg-glass`, `text-fg-2`, `rounded-card`…) |
| `plain-app.css` | adapter for apps **without** Tailwind: re-themes existing `button`, `input`, `.primary`, lists, modals |
| `components/ nav/ sound/ icons/` | reference code |

## Applying it to an existing app (no Tailwind, e.g. Electron + plain CSS)

1. `pnpm add lucide-react @fontsource-variable/outfit` (framer-motion only if the components with React animation are used; for plain CSS, transitions are enough).
2. Copy `tokens.css`, `base.css`, `plain-app.css` into the app and import them **after** its CSS (in that order). The old variables (`--bg`, `--text`, `--accent`…) end up aliased to the tokens.
3. Remove `@media (prefers-color-scheme: light)` if a fixed dark theme is wanted. Replace opaque sidebar/header/modal backgrounds with glass.
4. Copy `sound/` and `nav/`; mount `FocusProvider` at the root and `<Backdrop />` as the first child. `FocusManager` already recognizes native buttons and links.
5. Replace icon emoji (🔁 ⚙ ×) with Lucide's `Icon`.
6. Electron: `backgroundColor: '#05070d'` on the window. CSP: fonts through `@fontsource` stay `'self'`; it does not need touching.
7. Verify by looking at the app: focus with arrows, hover = focus, modal, `prefers-reduced-motion`.

## Stack for new projects

React + TypeScript + Tailwind v4 (tokens as CSS variables + `tailwind-theme.css`), `lucide-react`, `framer-motion`, `@fontsource-variable/outfit`, Vite.

## Checklist before calling it done

- [ ] All states (incl. disabled and loading) and hover == focus.
- [ ] Full keyboard use without a mouse; focus always visible; touch ≥ 44px.
- [ ] Only token variables, no loose hex values; no large opaque backgrounds.
- [ ] Lucide icons md/stroke 1.75; own ControlIcons.
- [ ] Every interaction calls the sound event; no bundled audio.
- [ ] `prefers-reduced-motion` and mute respected.

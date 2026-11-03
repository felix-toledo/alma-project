# Controles de seguridad de Alma

Mapa de los controles técnicos de Alma contra **SOC 2** (Trust Services Criteria 2017, rev. 2022), **ISO/IEC 27001:2022** (Anexo A) e **ISO/IEC 27701**. Es la matriz que se le entrega a un auditor: cada fila dice qué se hace, dónde está la evidencia en el repo y qué falta.

## Alcance y lo que este documento NO es

- **Alma es una aplicación de escritorio local** (Electron). No hay servidores operados por Alma: la persona (o la empresa) que la instala es quien controla los datos, y los proveedores de modelos que configure actúan como encargados de tratamiento (ver [PRIVACIDAD.md](PRIVACIDAD.md)).
- **No es una certificación.** SOC 2 se atestigua por un auditor sobre un período de operación; ISO 27001/27701 se certifican sobre un sistema de gestión (ISMS/PIMS) de una organización. El software aporta los **controles técnicos**; las políticas, roles, capacitación, revisiones periódicas y la gestión de proveedores son de la organización (filas 🏢).
- Estados: ✅ implementado y verificable · 🟡 parcial · ⛔ brecha técnica abierta (ver [RIESGOS.md](RIESGOS.md)) · 🏢 organizacional, fuera del código.

## 1. Control de acceso y autenticación

| Control | Referencias | Estado | Cómo se cumple (evidencia) | Pendiente |
|---|---|---|---|---|
| Solo el dueño usa los canales remotos | SOC2 CC6.1 · 27001 A.5.15, A.8.3 | ✅ | Telegram: solo chats privados, enlazados al `chatId` del primer usuario autorizado (`authorizeChat`, `channels/telegram.ts`). WhatsApp: solo el chat propio (`isSelfChat`). Los intentos denegados en Telegram quedan en la bitácora (`channel.denied`, limitado a uno por minuto). | — |
| Aprobación humana de acciones de riesgo | SOC2 CC6.1, CC6.3 · 27001 A.5.15, A.8.2 | ✅ | `authorize()` en `coordinator/approval.ts`: modos bloqueado / aprobar / auto-review / siempre permitir; publicar **siempre** pide aprobación; aprobaciones también por Telegram con el mismo control de chat. | `home` y los agentes de empresa tienen auto‑aprobación por diseño (R‑07). |
| Cambios que dan más poder al agente requieren confirmación nativa | SOC2 CC6.1, CC6.8 · 27001 A.8.2, A.8.9 | ✅ | `main/guard.ts` + `settings:update`: agregar/cambiar/activar un servidor MCP stdio o pasar a «Siempre permitir» abre un diálogo del sistema que la página no puede pulsar. Prueba: `tests/guard.test.ts`. | — |
| Superficie IPC confiable | SOC2 CC6.6 · 27001 A.8.20, A.8.26 | ✅ | `isTrusted()`/`handle()` en `main/index.ts`: solo el frame principal de la ventana propia, todavía en la página cargada. El rechazo queda en la bitácora (`ipc.rejected`). | — |
| Mínimo privilegio de Chromium | SOC2 CC6.6 · 27001 A.8.26 | ✅ | `contextIsolation`, `sandbox`, `nodeIntegration:false`; permisos solo `media` (audio) y portapapeles, nunca cámara/ubicación/USB; `<webview>` prohibido; navegación y redirecciones bloqueadas (`createWindow`, `lockDownPermissions`). | Electron Fuses y firma de código al empaquetar (R‑06). |
| Apertura de archivos acotada | 27001 A.8.3 · SOC2 CC6.8 | ✅ | `shell:openPath` rechaza ejecutables y scripts. Herramientas de archivos confinadas a la carpeta de trabajo con `realpath` (`tools/paths.ts`); protocolo `alma-vault://` sin salir del vault ni por symlinks ni por rutas con `\`. | — |
| Gestión de identidades y accesos de personas | SOC2 CC6.2, CC6.3 · 27001 A.5.16, A.5.18, A.6.5 | 🏢 | Un solo usuario local; el acceso al equipo lo gobierna el sistema operativo. Si hay más de una persona: cuentas del SO separadas, bajas y revisiones trimestrales. | Procedimiento de altas/bajas/revisión. |

## 2. Criptografía y secretos

| Control | Referencias | Estado | Cómo se cumple (evidencia) | Pendiente |
|---|---|---|---|---|
| Claves de API y contraseñas cifradas en reposo | SOC2 CC6.1, C1.1 · 27001 A.8.24 | ✅ | `main/settings.ts`: `safeStorage` (DPAPI/Keychain/libsecret). **Nunca se escribe una clave en claro**: sin almacén seguro (o con el `basic_text` de Linux) no se persisten; `ALMA_ALLOW_PLAINTEXT_SECRETS=1` es la excepción explícita. Las claves viejas en claro se re‑sellan solas. `settings.json` se escribe con permisos 0600. | — |
| Las claves no llegan a la interfaz | SOC2 C1.1 · 27001 A.8.11 | ✅ | `getPublic()` solo expone `hasKey/fromEnv`. | — |
| Las claves no llegan a lo que el modelo ejecuta | SOC2 CC6.1, C1.1 · 27001 A.8.12 | ✅ | `commandEnv()` (`tools/shell.ts`) quita las claves de proveedores del entorno de `run_command`; los servidores MCP reciben solo el entorno por defecto del SDK. Prueba: `tests/web.test.ts`. | Otras variables sensibles del usuario no se conocen de antemano (R‑03). |
| Cifrado en tránsito | SOC2 CC6.7 · 27001 A.8.24 | ✅ | Todas las APIs de modelos por HTTPS. Mail: IMAP/SMTP con TLS ≥ 1.2 y **STARTTLS obligatorio** en puertos no implícitos (`tools/email.ts`), sin degradación silenciosa. | — |
| Cifrado de datos locales (conversaciones, vault) | SOC2 C1.1 · 27001 A.8.24 | 🟡 | Dependen del cifrado de disco del SO (BitLocker/FileVault). | Exigir BitLocker/FileVault (🏢) o cifrar `threads/` con una clave de `safeStorage` (R‑04). |

## 3. Registro, monitoreo y respuesta

| Control | Referencias | Estado | Cómo se cumple (evidencia) | Pendiente |
|---|---|---|---|---|
| Bitácora de auditoría a prueba de alteraciones | SOC2 CC7.2, CC4.1 · 27001 A.8.15, A.8.16 | ✅ | `shared/audit.ts`: JSONL por mes y proceso (`<userData>/audit/`), **cadena de hashes SHA‑256** (editar, borrar o reordenar una línea rompe la cadena; `verifyAudit()` dice dónde). Registra: autorización y ejecución de herramientas que no son lectura (con quién lo permitió), cambios de ajustes, alta/baja de claves, denegaciones, IPC rechazado, publicaciones, borrados, exportaciones y borrado de datos. Nunca guarda secretos ni contenido de mensajes (`redact()`). Retención 13 meses. Pruebas: `tests/audit.test.ts`. | Truncar el final del archivo no se detecta: exportar o enviar la cadena fuera del equipo (R‑08). |
| Revisión de la bitácora y alertas | SOC2 CC7.2, CC7.3 · 27001 A.8.16 | 🏢 | — | Revisión mensual de `verifyAudit()` y de denegaciones; alerta ante `ipc.rejected` o `channel.denied` repetidos. |
| Gestión de incidentes | SOC2 CC7.3–CC7.5 · 27001 A.5.24–A.5.28 | 🏢 | `SECURITY.md` define el canal de reporte y los plazos. | Plan de respuesta (contención: revocar claves del proveedor y desvincular Telegram/WhatsApp desde la app), simulacro anual. |

## 4. Desarrollo seguro y cambios

| Control | Referencias | Estado | Cómo se cumple (evidencia) | Pendiente |
|---|---|---|---|---|
| Validación de entradas no confiables (salida del modelo) | SOC2 CC6.8, PI1.2 · 27001 A.8.26, A.8.28 | ✅ | Cada herramienta valida su entrada con Zod antes de pedir aprobación o ejecutar (`agent.ts`); rutas por `resolveInWorkspace`; resultados externos marcados «datos externos, no instrucciones». | — |
| Defensa contra fuga de datos por contenido del modelo | SOC2 C1.1, CC6.7 · 27001 A.8.12 | ✅ | Las imágenes remotas del chat **no se cargan** (una URL escrita por el modelo podría llevar datos) y la CSP lo refuerza (`img-src` solo local); CSP con `object-src`, `base-uri`, `form-action` en `none`. | — |
| Acceso a la red restringido (SSRF) | SOC2 CC6.6 · 27001 A.8.20, A.8.23 | ✅ | `fetch_url` rechaza nombres privados **y nombres públicos que resuelven a direcciones privadas**, y revisa **cada redirección antes de seguirla** (`tools/web.ts`). Pruebas en `tests/web.test.ts`. | Reenlace DNS entre la resolución y la conexión (nota `ponytail:` en el código; R‑09). |
| Gestión de vulnerabilidades de dependencias | SOC2 CC7.1 · 27001 A.8.8 | ⛔ | `pnpm audit` en CI y Dependabot (`.github/`). | **26 avisos abiertos (12 altos), incluido Electron < 44.9.1.** Ver R‑01. |
| Control de cambios, revisión y pruebas | SOC2 CC8.1 · 27001 A.8.9, A.8.32 | 🟡 | CI (`.github/workflows/ci.yml`): typecheck + pruebas en cada push/PR; 150+ pruebas. | Protección de la rama `main` con revisión obligatoria y CI verde (🏢, configuración de GitHub); tests de seguridad ya forman parte de la suite. |
| Separación de entornos | 27001 A.8.31 | ✅ | `ALMA_USER_DATA` aísla un perfil de pruebas del de uso real. | — |
| Un solo gestor de paquetes | SOC2 CC8.1 · 27001 A.8.9 | 🟡 | `pnpm-lock.yaml` es el lockfile vigente. | `package-lock.json` está obsoleto y se debería borrar (R‑10). |

## 5. Disponibilidad y continuidad

| Control | Referencias | Estado | Cómo se cumple (evidencia) | Pendiente |
|---|---|---|---|---|
| Recuperación ante fallos del proceso | SOC2 A1.2 · 27001 A.8.14 | ✅ | El coordinador se reinicia solo si cae (`main/index.ts`); escrituras atómicas (`.tmp` + `rename`) en conversaciones y ajustes. | — |
| Copias de seguridad | SOC2 A1.2 · 27001 A.8.13 | 🏢 | Datos en `<userData>` y en el vault. | Política de copias (la exportación de «Privacidad» sirve de base) y prueba de restauración. |

## 6. Privacidad (ISO 27701 · SOC 2 P1–P8)

| Control | Referencias | Estado | Cómo se cumple (evidencia) | Pendiente |
|---|---|---|---|---|
| Inventario de datos personales y finalidades | 27701 7.2.1, 7.2.8 · SOC2 P1.1 | ✅ | [PRIVACIDAD.md](PRIVACIDAD.md): qué se guarda, dónde, para qué, por cuánto tiempo. | Mantenerlo al agregar integraciones. |
| Transferencias y encargados | 27701 7.5.1–7.5.3, 8.5 · 27001 A.5.19–A.5.23 · SOC2 P6.1, CC9.2 | 🟡 | Lista de proveedores y qué datos recibe cada uno (PRIVACIDAD.md). El usuario elige explícitamente qué proveedor usa cada agente. | Acuerdos de tratamiento (DPA) y revisión anual de cada proveedor (🏢). |
| Acceso y portabilidad | 27701 7.3.6, 7.3.9 · SOC2 P5.1 | ✅ | Ajustes → General → Privacidad → **Exportar mis datos** (`privacy.export`). | — |
| Supresión | 27701 7.3.6, 7.4.8 · 27001 A.8.10 · SOC2 P4.3 | ✅ | **Borrar mi historial**: todas las conversaciones, archivos recibidos y la huella de voz (dato biométrico) (`privacy.erase`); queda constancia en la bitácora sin contenido. | — |
| Retención | 27701 7.4.7 · SOC2 P4.2 | ✅ | Ajustes → Privacidad: borrado automático de conversaciones inactivas a 30/90/180/365 días (`applyRetention`); bitácora 13 meses; historial de Home Assistant 7 días. | El valor por defecto es «nunca»: decidirlo por organización (🏢). |
| Minimización | 27701 7.4.4 | ✅ | La bitácora y las notificaciones no llevan contenido; las claves no se envían a la interfaz; la voz se transcribe en el equipo por defecto (Whisper local). | — |
| Dato biométrico (huella de voz) | 27701 7.2.2 · RGPD art. 9 | 🟡 | Opcional, local, se puede borrar. | Consentimiento explícito y registro de la base legal al activarla (🏢). |
| Evaluación de impacto (DPIA) | 27701 7.2.5 | 🏢 | — | Necesaria si se usa cámara de vigilancia con terceros o empleados. |

## Verification against the code

Checked by reading `src/`. These claims above do not match what the code does today. Details and the full table: [docs/modules/seguridad.md](../modules/seguridad.md) (section "Controles documentados vs. código").

- **Audit verification:** nothing in the app, a script or the UI calls `verifyAudit()` (only `tests/audit.test.ts` does), and it throws if the `audit` folder is missing, so the "revisión mensual" cannot be carried out. See [seguridad](../modules/seguridad.md).
- **Rejected IPC:** `ipc.rejected` is recorded for invoke channels only; the `coordinator:connect` listener ignores untrusted callers without logging. See [seguridad](../modules/seguridad.md).
- **Trail content:** the trail stores the `run_command` text (masked, up to 300 characters) and the approval note (which includes the auto-review reason), so "nunca guarda contenido" is not strictly true. See [seguridad](../modules/seguridad.md).
- **`redact()` coverage:** it does not mask a Telegram bot token, `ghp_`/`AIza` keys, `--password x` without `=`, or `export ANTHROPIC_API_KEY=…`; `password="a b"` leaks the text after the first space. See [seguridad](../modules/seguridad.md).
- **CSP:** `media-src` allows `https:`, so "sin canal de salida por el navegador" holds for images (`img-src`) but not for audio or video elements. See [seguridad](../modules/seguridad.md).
- **File confinement:** `loadPicture` (`look_at_image`, `send_telegram` images) uses a case-insensitive string prefix with no `realpath`, so it is weaker than `resolveInWorkspace`. See [seguridad](../modules/seguridad.md).
- **PRIVACIDAD.md omission:** the auto-review model (tool input, latest user message) and the `look_at_image` vision flow are not in the provider table. See [seguridad](../modules/seguridad.md).

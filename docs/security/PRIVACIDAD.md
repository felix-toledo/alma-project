# Privacidad: inventario de datos, encargados y derechos

Base para el registro de actividades de tratamiento (ISO/IEC 27701 7.2.8; SOC 2 P1–P8). **Alma no tiene servidores propios**: todo lo que guarda vive en la computadora de quien la usa (`%APPDATA%\Alma` y las carpetas que esa persona elija). Quien la instala es el responsable del tratamiento; los proveedores de la sección 2 son encargados o subencargados según lo que la persona configure.

## 1. Qué datos personales trata Alma

| Dato | Dónde queda | Para qué | Retención | Sale del equipo |
|---|---|---|---|---|
| Conversaciones con los agentes (`threads/`) | Disco local, JSON | Continuidad del trabajo | Hasta que se borren; borrado automático opcional (30/90/180/365 días) | Cada mensaje viaja al proveedor de modelos del agente |
| Archivos que la persona manda (fotos, audios; `inbox/`) | Disco local | Que el agente los vea o los transcriba | Hasta «Borrar mi historial» | Solo si el agente los analiza (proveedor de modelos) |
| Notas del vault y su índice de búsqueda (`knowledge/`) | Carpeta elegida por la persona; el índice, local | Memoria y búsqueda | La decide la persona | No: el modelo de embeddings (bge‑m3) corre en el equipo |
| Huella de voz (`voice-profile.json`) — **dato biométrico** | Disco local | Responder solo a su voz (opcional) | Hasta «Borrar mi historial» o «Olvidar mi voz» | No |
| Audio del micrófono | Memoria (no se guarda) | Dictado y asistente de voz | No se conserva | Solo si la transcripción es «OpenAI» o «Meta»; por defecto Whisper local |
| Credenciales (claves de API, token de Telegram, contraseña del mail) | `settings.json`, cifradas con el almacén del SO | Conectarse a los servicios | Hasta que se borren | Solo hacia el servicio al que pertenecen |
| Correo (lectura y envío por IMAP/SMTP) | No se almacena: se lee bajo demanda | Que el agente lea y redacte mails | — | El contenido leído viaja al proveedor de modelos |
| Chat de WhatsApp y Telegram | Sesión de WhatsApp en `whatsapp-auth*`; Telegram sin estado local | Hablar con Alma desde el celular | Hasta desvincular | A través de los servidores de WhatsApp/Telegram |
| Cámaras y dispositivos de la casa (Home Assistant embebido) | Local; historial de HA 7 días | Domótica y vigilancia con criterio | 7 días | Las fotos que se analizan van al proveedor de visión; las que se piden por Telegram, a Telegram |
| Empresas de agentes: tareas, reuniones, buzones | `companies/` y la carpeta de cada empresa | Trabajo en equipo de agentes | La decide la persona | Como las conversaciones |
| Bitácora de auditoría (`audit/`) | Disco local | Seguridad y rendición de cuentas | 13 meses | No. No contiene mensajes ni secretos |

## 2. Proveedores externos (encargados / subencargados)

Se activan solo cuando la persona carga la clave o elige el servicio. Región de tratamiento, base de transferencias internacionales y términos: **revisar el acuerdo de tratamiento (DPA) de cada uno antes de usarlo con datos de terceros** (🏢).

| Proveedor | Qué recibe | Cuándo |
|---|---|---|
| Anthropic (Claude), xAI (Grok), DeepSeek, Meta (Muse), Vercel AI Gateway (y los laboratorios detrás) | Mensajes, resultados de herramientas, imágenes adjuntas | Cuando un agente usa ese proveedor |
| OpenAI, xAI, Meta | Descripciones para generar imágenes | `generate_image` |
| OpenAI, Meta | Audio para transcribir | Transcripción en la nube activada en Voz |
| ElevenLabs | Texto a leer en voz alta | Voz «ElevenLabs» |
| Telegram, WhatsApp | Mensajes, fotos | Canales activados |
| DuckDuckGo y los sitios visitados | Consultas y dirección IP del equipo | `web_search`, `fetch_url` |
| Instagram | Publicaciones (siempre con aprobación) | `instagram_publish` |
| Servidor de correo configurado | Credenciales y mensajes | Mail activado |
| Hugging Face | Descarga única de modelos (voz, embeddings); no se envían datos | Primer uso |

## 3. Derechos de las personas y cómo se atienden

| Derecho | Cómo |
|---|---|
| Acceso y portabilidad | Ajustes → General → Privacidad → **Exportar mis datos**: copia las conversaciones, empresas, bitácora, rutinas y la huella de voz en una carpeta nueva. |
| Supresión | **Borrar mi historial** (conversaciones, archivos recibidos, huella de voz). El vault es de la persona: se borra desde el vault. Credenciales: *Borrar* en cada proveedor. |
| Retención / limitación | **Borrar conversaciones sin actividad** a 30/90/180/365 días. |
| Rectificación | Las conversaciones y notas son texto editable por la persona; Alma no genera perfiles. |
| Oposición al tratamiento por un proveedor | Cambiar el proveedor del agente o borrar su clave; la voz y los embeddings pueden quedar 100 % locales. |
| Solicitudes de terceros (si Alma procesa datos de otras personas, p. ej. un mail de un cliente) | Las atiende la organización responsable, con el mismo mecanismo de exportación y borrado, y el buscador del vault para localizar al titular. |

## 4. Privacidad desde el diseño

- Todo lo que puede ser local lo es por defecto: Whisper, Kokoro, embeddings y wake‑word corren en el equipo.
- Las claves se sellan con el almacén del sistema y no llegan a la interfaz ni al entorno de los comandos.
- Lo que sale del equipo es una elección explícita (proveedor por agente, canal por canal).
- La bitácora registra *qué* se hizo y *quién lo permitió*, nunca el contenido.
- Pendiente (🏢): base legal y consentimiento para la huella de voz y las cámaras; DPIA si se vigila a terceros; registro de actividades de tratamiento por organización.

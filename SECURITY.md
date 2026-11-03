# Seguridad

## Cómo reportar una vulnerabilidad

Escribí a **<correo de seguridad: completar>** con el asunto «Alma: vulnerabilidad», sin abrir un issue público. Incluí los pasos para reproducirla y la versión (`package.json`).

- Confirmación de recepción: 2 días hábiles.
- Evaluación y plan: 7 días.
- Corrección de severidad alta o crítica: 30 días; el resto, en la siguiente versión.

## Alcance

La aplicación de escritorio (`src/main`, `src/preload`, `src/coordinator`, `src/renderer`), sus herramientas y sus integraciones. No cubre vulnerabilidades de los servicios de terceros que Alma consume.

## Qué hay hecho

Mapa de controles contra SOC 2, ISO 27001 e ISO 27701: [docs/security/CONTROLES.md](docs/security/CONTROLES.md). Riesgos abiertos: [docs/security/RIESGOS.md](docs/security/RIESGOS.md). Datos personales y proveedores: [docs/security/PRIVACIDAD.md](docs/security/PRIVACIDAD.md).

## Si creés que una clave se filtró

1. Revocala en el panel del proveedor (Anthropic, xAI, Meta, etc.) y generá otra.
2. En Alma → Configuración → Proveedores, borrá la clave vieja y cargá la nueva.
3. Telegram: regenerá el token con @BotFather. WhatsApp: desvinculá el dispositivo desde el celular.
4. Revisá la bitácora (`%APPDATA%\Alma\audit`) a partir de la fecha de la filtración.

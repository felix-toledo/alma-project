---
status: accepted
---

# Home automation: Home Assistant in a hidden WSL2 distro, plus Alma's own 2D plan

The **House** (Casa) feature uses Home Assistant (HA) as its engine. Alma installs it into a hidden WSL2 distro named `alma-home` (HA 2026.10.1, the official container image exported with `crane`, no Docker, imported with `wsl --import`) and runs it as a child process. If the PC cannot run WSL, Alma connects to an HA the person already has (URL + token). HA stays the source of truth for devices, entities, areas, scenes and automations; Alma owns the **floor plan** (its own structured 2D top-down model, `plan.json`, drawn as SVG) and the intelligence. Code: `src/coordinator/home/`, `src/shared/home.ts`.

## Why

From [HOME-AUTOMATION-PLAN.md](../HOME-AUTOMATION-PLAN.md) section 2 and the design note "home-automation-design": maximum device compatibility (Tuya, eWeLink, Tapo/ONVIF, Hue, Chromecast and anything HA supports) without making the installer depend on a separate HA box. Excalidraw drawings and photos are only **inputs** to the plan; the view is Alma's own plan so it can be edited by dragging and by agents. Simple rules become HA automations (reliable, no tokens); rules needing judgment wake an agent with the event. HA is Python, an explicit exception to the "no Python" rule of [ADR 0008](0008-voice-in-js-on-onnxruntime.md), isolated inside WSL.

## Considered options

Named in DOMOTICA-PLAN section 4.1: **Plan B**, a minimal Ubuntu distro with `uv`, Python 3.14 and `pip install homeassistant` (the documented "Core" install), described as slower and more fragile; **Plan C**, an external HA (URL + token), kept as a supported mode. Network mode: WSL NAT is the default; `mirrored` was not built because it is configured in `%USERPROFILE%\.wslconfig` and affects all of the user's distros (the `mirrored` setting exists but nothing reads it).

## Consequences

- Windows 10/11 with WSL2 and virtualization only; other platforms are `unsupported`. Install needs 6.5 GB free (about 1.2 GB download, about 3 GB on disk, 4 to 10 minutes first time, about 30 s later starts).
- With NAT, LAN discovery (mDNS/SSDP) does not work: brands are added by account, cloud or IP.
- The engine stops when Alma quits, so HA rules do not run then.
- HA listens on `0.0.0.0` inside WSL; with WSL mirrored networking it could be exposed to the LAN (R-02 in [RISKS.md](../security/RISKS.md), open).
- The plan promised a 30 s health check with automatic restart; the code only recovers when the HA process exits.
- `home_call_service` is a general back door and does not guard garage/gate covers; scenes can set locks without asking.
- Downloads come from GitHub (`crane`, SonoffLAN) and `ghcr.io` (HA image); the HA token and owner password are sealed with `safeStorage` ([ADR 0013](0013-secrets-with-safestorage.md)).
- Tested for real with HA's demo integration and a full install/uninstall; not verified with the user's real Tuya/eWeLink/Tapo devices (design note).
- Audio (speakers and microphones per room) is not built.

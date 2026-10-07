# SV Digital Twin Labs — Roadmap

**What we are building:** an open-source **factory digital-twin platform**. Engineers, students and small and medium manufacturers can use it to:
1. **model** a production line,
2. **run** it as a live, deterministic simulation, or **mirror** a real line from PLC/SCADA data,
3. **see** it in an operations-grade console (web) or in 3D (Unity),
4. **experiment** safely with what-if scenarios, fault drills and optimisation, before touching the real plant.

V1 is the **base**: one engine, one wire contract and several clients. Every later phase plugs into the same contract (`contracts/`). That's what lets the pieces be built in parallel.

```
            ┌──────────── contracts/ (one wire protocol) ────────────┐
 Sources    │  Twin Server (.NET 10)                │  Clients         │
 ─────────  │  ─────────────────────                │  ───────         │
 Simulation ┼─▶ Engine ─▶ Analytics ─▶ REST + WS ───┼─▶ Web console    │
 OPC UA*    ┼─▶  (*v0.2)   OEE/alarms/what-if       ┼─▶ Unity 3D       │
 MQTT*      ┼─▶            History/Store*           ┼─▶ Python/RL*     │
            └───────────────────────────────────────┴──────────────────┘
```

## v0.1 — Base Twin ✅ (this release)
- [x] Deterministic line simulator: 7 asset kinds, wear-driven faults, sensor models.
- [x] Analytics: OEE (A×P×Q), bottleneck detection, ISA-18.2 style limit, anomaly and fault alarms, and a what-if runner.
- [x] ASP.NET Core API: the REST and WebSocket contract, a real-time loop from ×0.25 to ×100, history and CSV export.
- [x] Unity 6 client: procedural plant, live state, on-screen controls.
- [x] Web console in a WinForms/MATLAB style: 3D viewport, trends, KPIs, property grid, alarms and what-if.
- [x] CI, Docker image, dev and smoke scripts.

## v0.2 — Connected Twin (real data in)
Goal: the twin can **mirror a real or emulated line**, not only simulate one.
- **Tag model.** Map each sensor or asset state to an external tag (`opcua://…`, `mqtt://topic`) in the plant JSON.
- **OPC UA adapter.** Built on OPCFoundation UA-.NETStandard. Subscribes to tags and normalises them into `SensorValue`/`AssetState`.
- **MQTT adapter.** Built on MQTTnet, with a Sparkplug-B-friendly topic scheme.
- **Virtual PLC.** A built-in OPC UA server that exposes the *simulated* line as tags. Learners get a realistic endpoint to connect SCADA tools to, and we get an end-to-end test loop.
- **Twin modes.** `simulate` runs the engine. `shadow` lets real data drive the state while the engine predicts ahead and flags deviations between prediction and reality.
- **Persistence.** SQLite for scenarios and events. TimescaleDB is optional for long history. Includes saved what-if scenarios.

## v0.3 — Plant Builder
- A layout editor in the web console: drag assets from a palette, connect flows, edit params, validate, and save as plant JSON.
- Multiple lines per plant, shared resources (operators, AGVs) and shift calendars.
- Asset mesh import: FreeCAD → glTF, used by both Three.js and Unity, with procedural meshes as the fallback.
- A library of templates: machining cell, assembly line, battery-cell line (electrode → assembly → formation → pack).

## v0.4 — Learning Lab
- Guided scenarios such as "Find the bottleneck", "Predictive maintenance: catch the bearing before it fails", "SMED changeover" and "Buffer sizing". Each has goals, scoring and hints.
- An instructor mode that pushes faults to a class, plus multi-user sessions.
- Auth and multi-tenancy (Keycloak/OIDC) for hosted classrooms.

## v0.5 — Optimisation AI
- A Python SDK plus a Gymnasium environment over the headless engine, through a gRPC or engine-CLI bridge.
- RL and heuristic agents for dispatching, buffer sizing and maintenance timing, benchmarked through what-if.
- A predictive-maintenance model (remaining useful life) trained on the engine's wear and vibration signals.

## v1.0 — Public Showcase
- Hosted demo (Docker/Kubernetes), docs site, contributor guide and hackathon kits.
- Scale work toward the Mission targets: Unity DOTS for large plants, and a sharded engine per line.

---
**Working rules:** the contract comes first; each feature gets its own branch (`feature/*`, `fix/*`, `chore/*`, `docs/*`), merged `feature → develop`, with releases going `develop → main` and a tag. Every merge must keep CI green.

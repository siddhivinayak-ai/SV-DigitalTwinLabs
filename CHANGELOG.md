# Changelog

## v0.1.0 — Base Twin (2026-10-07)
First working release: a live digital twin of one production line ("Line A", 11 assets, 32 sensors).

- **Simulation engine** (C#, .NET 10): deterministic and seeded, with a fixed 0.1 s tick. Covers sources, conveyors, machines, buffers, robots, inspection and sinks, wear-driven faults with MTTR repair, sensor models, and fault, maintenance and enable commands. An 8 h run takes about 0.4 s.
- **Analytics**: OEE (A×P×Q) per asset and per line, rolling throughput, bottleneck detection, and ISA-18.2-style alarms (limits with on-delay and off-delay, EWMA vibration anomaly, faults). The what-if runner compares baseline and scenario with the same seed.
- **API** (ASP.NET Core): the full REST + WebSocket contract (`contracts/`), a real-time loop from ×0.25 to ×100, sensor history, CSV export, and static hosting of the console.
- **Web console** (Vite + TypeScript, no framework): a WinForms/MATLAB-style shell with docked panes, a Three.js 3D line with animated machines and parts, MATLAB-style trends, OEE gauges, a property grid with live parameter editing, the event log, alarms with acknowledge, a data grid, and the what-if and fault dialogs. Light and dark (Control Room) themes, plus a demo mode with no server.
- **Unity 6 client**: a procedural plant, live state over WebSocket, an on-screen HUD with controls, and an offline example preview.
- **Tooling**: CI (GitHub Actions), a Docker image, `scripts/dev.ps1`, and `scripts/smoke.ps1` (16 end-to-end checks).
- **Tests**: 131 server and 124 UI.

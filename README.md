# SV Digital Twin Labs

An open-source **digital twin of a manufacturing production line**. A C# simulation server streams live machine state to an operations-grade web console and a Unity 3D client.

> V1 scope: one production line, "Line A – Precision Machined Housing", with 11 assets, synthetic sensors, fault injection, OEE analytics and what-if scenarios.

```
┌──────────────────────────────┐    WebSocket /ws  +  REST /api     ┌───────────────────────────┐
│  TwinLabs.Api (ASP.NET 10)   │ ─────────────────────────────────▶ │  Web Console (Vite + TS)  │
│  ├ Simulation engine (C#)    │                                    │  Three.js · uPlot         │
│  ├ Analytics (OEE, anomaly)  │ ─────────────────────────────────▶ │  Unity 6 client           │
│  └ What-if runner            │                                    │  (twin-engine/)           │
└──────────────────────────────┘                                    └───────────────────────────┘
```

## Repository layout
| Path | Contents |
|---|---|
| `contracts/` | Wire protocol spec, plant model JSON and canonical example payloads. **This is the source of truth for both sides.** |
| `server/` | .NET 10 solution: `Core`, `Simulation`, `Analytics`, `Api`, `Tests` |
| `ui/` | Web console: Vite + vanilla TypeScript, no framework |
| `twin-engine/` | Unity 6 client that renders the same live twin |
| `docs/` | Vision, architecture and the V1 spec |
| `scripts/` | Dev and smoke-test scripts |

## Quick start
```powershell
# Server (http://localhost:5080)
cd server; dotnet run --project src/TwinLabs.Api

# UI dev server (http://localhost:5173, proxies /api and /ws to :5080)
cd ui; npm install; npm run dev
```
Or run both at once with `./scripts/dev.ps1`.

## Branching
- `main` holds releases only and is tagged (`v0.1.0`, …).
- `develop` is the integration branch.
- Work happens on `feature/*`, `fix/*` and `chore/*` branches, which merge into `develop`.

Use conventional commits: `feat(sim): …`, `fix(ui): …`, `chore: …`.

## License
MIT. See [LICENSE](LICENSE).

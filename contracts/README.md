# TwinLabs Wire Contract (v1)

This folder is the **source of truth** for everything that crosses a process boundary.

| Side | Mirror | Guard |
|---|---|---|
| C# | `server/src/TwinLabs.Core/Contracts/*.cs` | `server/tests/TwinLabs.Contracts.Tests` round-trips every example |
| TypeScript | `ui/src/net/contracts.ts` | `ui/src/net/contracts.test.ts` parses every example |
| Unity | `twin-engine/Assets/TwinLabs/Scripts/Net/Contracts.cs` | n/a |

Any change to the contract has to update **all three**, plus `examples/`.

## Conventions
- JSON with camelCase property names. Enums are camelCase strings, for example `"running"` or `"fault"`.
- **Null fields are omitted.** Optional fields can be absent.
- Times are **sim milliseconds** since reset (`t`, `simTimeMs`, `timeMs`, `stateSinceMs` …) and are always integers.
- Coordinates are metres in a right-handed frame with Y up. X runs along the line. Unity is left-handed, so Unity clients negate Z.
- Sensor ids are `"<ASSET-ID>.<suffix>"`, for example `CNC-01.temp`.

## Plant model
See `plant/sample_line.json` (`PlantModel`). It holds `assets[]` (`AssetDef`) and `sensors[]` (`SensorDef`). Asset `params` is a flat `{ key: number }` map. `docs/V1-Spec.md` lists the keys and what they mean.

## WebSocket `ws://host:5080/ws`
Every frame uses the same envelope:
```json
{ "type": "tick", "t": 761300, "seq": 3807, "data": { } }
```
`seq` counts up by one per frame on a connection, so a client can detect gaps.

### Server → client
| type | data | When |
|---|---|---|
| `snapshot` | `SnapshotData` | Once on connect, and again after `sim.reset` |
| `tick` | `TickData` | About 5 Hz while connected, including when paused, so the clock stays live |
| `event` | `EventRecord` | Faults, repairs, maintenance, param changes, commands, info |
| `alarm` | `Alarm` | An alarm was raised, escalated, cleared or acknowledged (the full alarm object each time) |
| `kpi` | `KpiReport` | 1 Hz |
| `params` | `ParamsData` | After an asset's params changed |
| `ack` | `AckData` | Reply to every `command` |

### Client → server
`type: "command"`, with `data` set to a `CommandData` object: `{ id, action, assetId?, value?, params?, alarmId?, durationS? }`.

| action | Fields |
|---|---|
| `sim.start` / `sim.pause` / `sim.stop` / `sim.reset` | none |
| `sim.speed` | `value` (0.25–100) |
| `asset.params` | `assetId`, `params` |
| `asset.fault` | `assetId`, `durationS?` |
| `asset.clearFault` | `assetId` |
| `asset.maintenance` | `assetId`, `value` 1 or 0 |
| `asset.enable` | `assetId`, `value` 1 or 0 |
| `alarm.ack` | `alarmId` |

## REST `http://host:5080/api`
| Method | Path | Body | Returns |
|---|---|---|---|
| GET | `/health` | none | `HealthData` |
| GET | `/plant` | none | `PlantModel` |
| GET | `/state` | none | `SnapshotData` |
| GET | `/kpi` | none | `KpiReport` |
| GET | `/history/{sensorId}?seconds=600` | none | `HistorySeries` |
| GET | `/events?limit=200` | none | `EventRecord[]` |
| GET | `/alarms` | none | `Alarm[]` (active) |
| POST | `/sim/start` `/sim/pause` `/sim/stop` `/sim/reset` | none | `SimStatus` |
| POST | `/sim/speed` | `SpeedRequest` | `SimStatus` |
| PATCH | `/assets/{id}/params` | `ParamsRequest` | `AssetDef` |
| POST | `/assets/{id}/fault` | `FaultRequest` | `AssetState` |
| DELETE | `/assets/{id}/fault` | none | `AssetState` |
| POST | `/assets/{id}/maintenance` | `ToggleRequest` | `AssetState` |
| POST | `/assets/{id}/enable` | `ToggleRequest` | `AssetState` |
| POST | `/alarms/{id}/ack` | none | `Alarm` |
| POST | `/whatif` | `WhatIfRequest` | `WhatIfResult` |
| GET | `/export/csv?seconds=3600` | none | `text/csv` (columns: `simTimeMs`, then one column per sensor id) |

Errors use RFC 7807 `application/problem+json`. An unknown asset or sensor returns 404, and bad values return 400.

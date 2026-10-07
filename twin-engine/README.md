# TwinLabs Twin Engine (Unity 6 client)

This is the 3D client for the SV-DigitalTwinLabs factory twin. It connects to the C# server over WebSocket (`ws://host:5080/ws`) and renders the live production line: assets, ISA-101 status beacons, moving parts and KPIs. It is built for Unity **6000.2.6f1** with the Universal Render Pipeline (URP).

The wire protocol is defined in [`../contracts/README.md`](../contracts/README.md). This client mirrors it in `Assets/TwinLabs/Scripts/Net/Contracts.cs`.

## 1. Open the project
1. Open **Unity Hub**. Click **Add**, then **Add project from disk**, and select this `twin-engine` folder.
2. Open it with Unity **6000.2.6f1**. Any 6000.2.x should work, but other versions will offer to upgrade the project.
   The first import takes a few minutes while Unity downloads the packages (URP, Input System, Newtonsoft JSON) and builds `Library/`.
3. Open **`Assets/TwinLabs/Scenes/TwinScene.unity`**. You can also use the menu **TwinLabs → Open Twin Scene**.
   If the scene is ever missing or broken, run **TwinLabs → Create Twin Scene** to rebuild it.

## 2. Start the server
From the repo root:
```powershell
cd server
dotnet run --project src/TwinLabs.Api
```
The server listens on **http://localhost:5080**. The client derives the WebSocket URL itself: `http://` becomes `ws://`, and `/ws` is appended.

## 3. Press Play
- The `TwinLabs` GameObject connects to `serverUrl`, which defaults to `http://localhost:5080`. Change it in the Inspector or in the HUD's URL box, then click **Connect**.
- On connect, the server sends a `snapshot`. The plant is then built procedurally, with no prefabs. `tick` frames (~5 Hz) drive the states and parts, and `kpi` frames (1 Hz) fill the KPI strip.
- **No server?** Click **Load Example** in the HUD toolbar, or use the menu **TwinLabs → Load Example Snapshot** while in Play mode. This builds Line A from `../contracts/plant/sample_line.json` and applies `../contracts/examples/tick.json`, `kpi.json`, `alarm.json` and `event.json`. In Edit mode, the same menu builds a static preview that is not saved with the scene. Remove it with **TwinLabs → Clear Preview**.

### Controls
| Input | Action |
|---|---|
| LMB drag / RMB drag | Orbit |
| MMB drag / Shift+LMB drag | Pan |
| Mouse wheel | Zoom |
| LMB click on an asset | Select it and open the **Properties** pane (state, time in state, load, wear, cycle, WIP, good/scrap, sensors with HI/HIHI colouring, asset KPIs, params) |
| F | Focus the selected asset |
| H / Home | Frame the whole plant |
| Esc | Clear the selection |

The HUD toolbar has **Start / Pause / Stop / Reset** (`sim.*`) and speed buttons for 0.25x to 100x (`sim.speed`). The Properties pane has **Inject Fault / Clear Fault / Maintenance / Disable** (`asset.*`), and the Alarms tab has **Ack** (`alarm.ack`). Commands are only enabled while the client is connected. Each one gets an `ack`, and rejected commands are logged to the Console.

### Status colours (ISA-101, docs/V1-Spec.md §4)
Equipment is grey, and only the beacon carries colour:

| State | Beacon |
|---|---|
| Running | green `#76B900` |
| Starved | steady amber `#E8A317` |
| Blocked | pulsing amber `#E8A317` |
| Fault | red `#D0021B`, blinking at 2 Hz |
| Maintenance | blue `#4A90D9` |
| Idle / Off | grey `#A0A0A0` |

Selection is shown by an IBM-blue `#0F62FE` floor frame.

## 4. Coordinates
The contract uses metres in a **right-handed frame with Y up**, with X running along the line. Unity is left-handed, so the client mirrors Z:

| Contract | Unity |
|---|---|
| `position (x, y, z)` | `(x, y, -z)` |
| `rotationY` (degrees) | `-rotationY` |
| `size (x, y, z)` | `(x, y, z)` (extents, no sign flip) |

So `CNC-01` at contract `z = -2.2` sits at Unity `z = +2.2`, which is the far side of the line when you look from the default camera. The conversion lives in `TwinJson.ToUnity` and `TwinJson.RotationYToUnity`.

## 5. Layout
```
Assets/TwinLabs/
  Scenes/TwinScene.unity          camera + lights + TwinLabs object (wired)
  Scripts/TwinLabs.Unity.asmdef   runtime assembly (refs Newtonsoft.Json, Unity.InputSystem)
  Scripts/Net/Contracts.cs        DTO mirror of the v1 contract + TwinJson settings
  Scripts/Net/TwinConnection.cs   ClientWebSocket on a background task, main-thread dispatch, reconnect
  Scripts/Twin/PlantBuilder.cs    PlantModel -> GameObjects, floor grid, selection, picking
  Scripts/Twin/AssetView.cs       per-asset geometry, beacon, animations, part placement
  Scripts/Twin/PartsView.cs       pooled part cubes, eased between ticks
  Scripts/Twin/TwinVisuals.cs     colour tokens, URP/Built-in materials, primitives
  Scripts/UI/HudOverlay.cs        IMGUI engineering HUD + click-to-select
  Scripts/Camera/OrbitCamera.cs   orbit / pan / zoom / focus
  Scripts/Camera/TwinInput.cs     Input System / legacy input shim
  Scripts/Editor/TwinLabsSetup.cs     menu: Create/Open Twin Scene, Load Example, Clear Preview
  Scripts/Editor/TwinLabsSelfTest.cs  menu: Run Contract Self-Test (round-trips contracts/examples)
```

## 6. Headless checks
```powershell
$unity = "C:\Program Files\Unity\Hub\Editor\6000.2.6f1\Editor\Unity.exe"
# compile + (re)create TwinScene
& $unity -batchmode -nographics -projectPath "$PWD\twin-engine" -executeMethod TwinLabs.Unity.Editor.TwinLabsSetup.CreateSceneBatch -quit -logFile build.log
# parse + re-serialise every contracts/examples/*.json (exit code 1 on mismatch); optional preview PNG needs a GPU (omit -nographics)
& $unity -batchmode -projectPath "$PWD\twin-engine" -executeMethod TwinLabs.Unity.Editor.TwinLabsSelfTest.RunBatch -twinShot "$PWD\preview.png" -logFile selftest.log
Select-String -Path build.log,selftest.log -Pattern "error CS","\[TwinLabs\]"
```
Close the project in the Editor before you run batchmode against it, because Unity locks open projects.

## 7. Troubleshooting
- **The status stays `CONNECTING` or `DISCONNECTED`.** Check that the server is running and that `http://localhost:5080/api/health` answers. The status bar shows the last socket error. The client retries with backoff (0.5 s, doubling to 10 s).
- **The HUD shows `gaps N`.** Frames were missed, because the `seq` numbers were not contiguous. This is harmless, since the next tick carries the full state.
- **Commands are greyed out.** They only work while the client is `CONNECTED`. `Load Example` is offline mode.
- **`InvalidOperationException: You are trying to read Input using the UnityEngine.Input class`.** Something outside TwinLabs is using legacy input. TwinLabs reads input through `TwinInput`, which works with either **Active Input Handling** setting (Project Settings → Player).
- **Everything is pink.** URP is not active. Check **Project Settings → Graphics** and confirm that the Default Render Pipeline is `PC_RPAsset`. The client falls back to the `Standard` shader when no pipeline is set.
- **There is no plant, but the client is connected.** The plant is built from the `snapshot` frame. If the server sent none, reconnect, or check the server log.
- **WebGL.** It is not supported, because `System.Net.WebSockets.ClientWebSocket` is not available in WebGL builds. Use the Editor or a Windows, macOS or Linux standalone build.
- **The project has a different editor version.** Unity Hub offers to upgrade it. Unity 6000.2.x is recommended, and `ProjectSettings/ProjectVersion.txt` pins 6000.2.6f1.

## 8. Contract notes and gaps
These are client-side assumptions to confirm with the server team:
- **`rotationY` units.** The contract does not say whether it is in degrees or radians. This client assumes **degrees**. Every asset in `sample_line.json` uses 0.
- **Parts on robots and sinks.** `progress` for a `robot` is ignored, and the part rides the gripper. For a `buffer`, `progress` is mapped onto rack slots (`floor(progress × capacity)`).
- **Ticks may carry a subset of assets.** `tick.json` lists only 4 of the 11 assets. The client merges each tick into its last known state rather than treating missing assets as gone. Parts, by contrast, are treated as the full set every tick.
- **Part identity.** `PartPosition` carries no good/scrap flag, so every part looks the same.
- **Pick and place targets.** Robots have none in the contract. The client aims the robot at its upstream asset (the one that lists it in `downstream`) and at `downstream[0]`.

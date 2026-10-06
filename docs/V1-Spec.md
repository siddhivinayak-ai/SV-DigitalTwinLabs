# V1 Specification — Line A Digital Twin

## 1. Goal
Run a live, deterministic simulation of one production line on an ASP.NET Core 10 server. Stream the line's state to:
- a web console with a dense, operations-grade look in the style of WinForms, MATLAB and IBM tools
- a Unity 6 3D client

Users can start, pause and change the speed of the sim, inject faults, edit asset parameters, watch KPIs and trends, and run headless what-if scenarios.

The wire protocol is defined in [`contracts/README.md`](../contracts/README.md).

## 2. Plant: "Line A – Precision Machined Housing"
```
Source → Conv-01 → ┬ CNC-01 ┬ → Buf-01 → Robot-01 → Assy-01 → Conv-02 → QC-01 → Pack-01 → Sink
                   └ CNC-02 ┘
```
The full model is in `contracts/plant/sample_line.json`.

| Kind | Behaviour |
|---|---|
| `source` | Releases raw parts at `arrivalIntervalS`. When downstream is full, it is Blocked. |
| `conveyor` | A FIFO with `capacity` slots. Transit time = `lengthM / speedMps`. A part exits only when it has reached the end and downstream accepts it. |
| `machine` | Processes one part at a time. Cycle time ~ Normal(`cycleTimeS`, `cycleTimeStdS`), clamped to ≥ 0.2×mean. Failures follow MTBF/MTTR. Each finished part is scrapped with probability `scrapRate`. |
| `buffer` | A FIFO with `capacity`. It has no processing time. |
| `robot` | A machine with pick-and-place cycle time. |
| `inspection` | A machine whose scrap is counted as a QC reject (`rejectRate`). |
| `sink` | Consumes good parts. It counts throughput. |

When an asset has more than one downstream (`Conv-01 → CNC-01 | CNC-02`), the part goes to the first free one, in round-robin order.

### 2.1 Asset states (PackML-inspired)
`Off`, `Idle`, `Running`, `Starved`, `Blocked`, `Fault`, `Maintenance`.

| State | Meaning |
|---|---|
| Running | Processing or transporting a part. |
| Starved | Free to work but nothing is upstream. |
| Blocked | Holding a finished part that downstream cannot accept. |
| Fault | Failed. It recovers after a time ~ Exp(`mttrS`). |
| Idle | The sim is paused or stopped, or the asset is enabled but has no work at start. |
| Maintenance | Set manually through a command. |
| Off | The asset is disabled. |

### 2.2 Failure and wear model
- `wear` starts at 0 and rises with processing time: `wear += dt / mtbfS`.
- The fault hazard per tick is `dt / mtbfS × (1 + 3·wear²)`. Failures become more likely as wear builds up.
- Vibration is `baseline + wear × 6 mm/s` + noise. This makes vibration a leading indicator of faults.
- A repair (when the Fault ends) resets `wear` to `wear × 0.2`.

### 2.3 Sensors
Each sensor has the shape `{ id, assetId, kind, unit, value }`. Noise is Gaussian at `noise × nominal`.

| Kind | Unit | Model |
|---|---|---|
| `temperature` | °C | First-order lag towards `ambient + load × rise`, with time constant 120 s. |
| `vibration` | mm/s | Baseline when idle and `baseline + wear×6` when running. |
| `power` | kW | `idleKw + load × (ratedKw − idleKw)`. |
| `current` | A | `power / (√3 × 0.4 kV × 0.9)`. |
| `speed` | m/s | Conveyor speed, or 0 if the conveyor is not Running. |
| `level` | count | Buffer or conveyor occupancy. |
| `count` | count | Cumulative good, scrap or reject counts. |

### 2.4 Engine
- **Fixed tick:** `dt = 0.1 s` of sim time. The real-time loop runs `speed` ticks' worth of sim time per 100 ms of wall time. Speed ranges from 0.25 to 100.
- **RNG:** `System.Random(seed)`. The same seed and the same commands give identical results.
- **Headless mode:** `RunFor(TimeSpan simTime)` runs as fast as possible and is used by what-if.
- **What-if runs** build fresh engines from a plant model through `ISimulationEngineFactory`. They do not clone live state. Each run starts empty, so callers should allow for the warm-up period.

## 3. Analytics
- **Availability** = (planned − fault − maintenance) / planned.
- **Performance** = (ideal cycle × total count) / run time.
- **Quality** = good / total.
- **OEE** = A × P × Q, computed per machine-type asset. Line OEE uses the bottleneck's A×P with the line's overall Q.
- **Throughput** = good parts per hour over a rolling 1 h window. WIP is the number of parts inside the line.
- **Bottleneck:** the asset with the highest active fraction (Running + Fault). When values are close, the tie-break is the lowest Blocked fraction.
- **Anomaly:** an EWMA mean and variance per sensor (α=0.05). When |z| > 4 for at least 3 consecutive samples, it raises an alarm of severity `warning`. When |z| > 6, the severity is `critical`. There are also static limits from the plant JSON (`hiHi`, `hi`).
- **What-if:** take the base plant (the live engine's current params when `fromLive`, otherwise the original model). Build two fresh engines with the same seed: the baseline as-is and the scenario with overrides applied. Run each headless for `durationS` and return both KPI reports plus the deltas (`oee`, `availability`, `performance`, `quality`, `throughputPerHour`, `good`, `scrap`, `wip`).

## 4. UI design language
- **Chrome:**
  - classic control grey `#D4D0C8`, panels `#ECE9D8`, window bg `#F5F4EE`
  - 1px bevels: highlight `#FFFFFF`, shadow `#808080`, dark `#404040`
- **Title bars of docked panes:** a navy gradient from `#0A246A` to `#3A6EA5` with white bold 11px text.
- **Fonts:** `Tahoma, "Segoe UI", sans-serif` at 11px. Numerics use `Consolas, "Courier New", monospace`, right-aligned and tabular.
- **Density:** rows are 18px high, toolbar buttons are 22px, and nothing is rounded beyond a 2px radius.
- **Plots:** MATLAB style, with a white axes area, `#E5E5E5` grid, black box frame and 10px tick labels. The colour order is `#0072BD #D95319 #EDB120 #7E2F8E #77AC30 #4DBEEE #A2142F`.
- **ISA-101 status colours:** normal states are grey, and colour is used only when something is abnormal or active.

  | State | Colour | Notes |
  |---|---|---|
  | Running | `#76B900` | NVIDIA green LED |
  | Idle / Off | `#A0A0A0` | |
  | Starved | `#E8A317` | amber |
  | Blocked | `#E8A317` | amber, hatched |
  | Fault | `#D0021B` | red, blinking in the LED |
  | Maintenance | `#4A90D9` | |
  | Selection / focus | `#0F62FE` | IBM blue |
- **Dark "Control Room" theme:** the same tokens with dark values: bg `#1E1F22`, panel `#2B2D31`, text `#D4D4D4`, title `#111` with `#76B900` accent. Theme switching is done through `data-theme="dark"` on `<html>`.

### 4.1 Layout
```
┌ MenuBar: File Edit View Simulation Analysis Tools Help ───────────────────────┐
├ ToolStrip: [▶][⏸][■][⟲] │ Speed [1x▾] │ [⚠ Inject Fault…] [⚙ What-If…] ...   │
├──────────┬──────────────────────────────────────────────┬────────────────────┤
│ Plant    │  3D Viewport                                 │ Properties         │
│ Explorer │                                              │ (PropertyGrid)     │
│ (Tree)   │                                              ├────────────────────┤
│          ├──────────────────────────────────────────────┤ KPIs               │
│          │ [Trends][Event Log][Alarms][Data Grid]       │ (OEE gauges, tiles)│
├──────────┴──────────────────────────────────────────────┴────────────────────┤
│ StatusBar: ● CONNECTED │ Sim 00:12:41.3 │ ×1.0 │ RUNNING │ 60 fps │ seq 1234  │
└──────────────────────────────────────────────────────────────────────────────┘
```
All the splitters can be resized. Selecting an asset anywhere (in the tree, the 3D view or the grid) sets the global selection, and every panel follows it.

# Plant Templates (v0.3)

Ready-made plants for the Plant Builder and for `GET /api/templates`. Each template is
`contracts/plant/templates/<id>.json` (a `PlantModel`; the id is the file-name stem) with a sibling
`<id>.meta.json` that gives `description` and `tags`. See `docs/V0.3-PlantBuilder.md` §5.

| Id | Assets | Lines | v0.3 features | Teaches |
|---|---|---|---|---|
| `machining-cell` | 9 | 1 | operator resource (count 1) shared by two CNCs | resource contention |
| `assembly-line` | 11 | 2 | calendar with day and evening shifts; stations on the day shift | serial bottleneck, buffering, shifts |
| `battery-cell-line` | 17 | 3 | `tool` resource for formation channels | long-cycle bottlenecks, big buffers, multi-line KPIs |

Shared conventions (copied from `contracts/plant/sample_line.json`):

- The flow runs along +X, with a 1.5 m aisle between columns. Parallel stations sit side by side in Z, 1.2 m apart. `rotationY` is 0 everywhere, and no footprints overlap.
- Sensors:
  - machine and robot: `temp`, `vib`, `power` and `current`
  - inspection: `temp`, `vib`, `power` and `rejects` (count)
  - conveyor: `speed`, `level` and `power`
  - buffer: `level`, with `hi` = capacity − 1
  - sink: `good` (count)
- Sensor limits:
  - Temperature `hi` sits a few °C above the asset's steady running temperature (`ambientC + tempRiseC`), and `hiHi` = `hi` + 10.
  - Vibration limits follow the ISO 10816 zones: 1.8/2.8, 2.8/4.5 or 4.5/7.1 mm/s, depending on how stiff the machine is.
  - Current `hi` is about 112 % of the rated current (`ratedKw / (√3 · 0.4 kV · 0.9)`).

The expected KPIs come from `TemplateTests.Template_runs_8h_with_good_parts_and_oee_in_range`: 8 sim hours from t = 0 with the template's own seed, using the whole-line `KpiCalculator` report. Each 8 h run takes about 0.2–0.35 s. The figures marked "today" were measured on an engine that **ignores** `resourceId`, `shiftId` and `calendar`. The "with v0.3 engine" figures are estimates.

---

## 1. `machining-cell`: Machining Cell (Twin CNC with Shared Operator)

```
                           ┌ CNC-01 ┐   (both need OP-01)
SRC-01 → CONV-01 ──────────┤        ├→ BUF-01 → ROB-01 → QC-01 → PACK-01 → SNK-01
 30 s     6 m @ 0.25 m/s   └ CNC-02 ┘     cap 8    18 s     20 s     15 s
                             40 s each
```

| Asset | Key params |
|---|---|
| SRC-01 Bar Stock Feeder | arrival 30 ± 3 s |
| CONV-01 Infeed Conveyor | 6 m, 0.25 m/s, capacity 5 |
| CNC-01/02 Vertical Machining Centre | cycle 40 ± 3 s, MTBF 6 h, MTTR 7 min, scrap 1.5 %, 15 kW, `resourceId: OP-01` |
| BUF-01 | capacity 8 |
| ROB-01 Deburr and Transfer Robot | cycle 18 s |
| QC-01 CMM Inspection | cycle 20 s, reject 2 % |
| PACK-01 | cycle 15 s |
| Resource `OP-01` | operator, count 1 |

**What it teaches: resource contention.** The two CNCs together could machine one part every 20 s, and the feeder supplies one every 30 s. With one shared operator, though, only one CNC can be in cycle at a time, so the cell's real capacity is 3600 / 40 = 90 parts/h. The CNC that is waiting shows `Starved` even when parts are queued on the conveyor, and `KpiReport.resources[OP-01]` reports roughly 100 % utilisation and a growing `waitSeconds`. Suggested what-ifs:
- Set `OP-01.count` to 2: throughput goes back to the 120/h arrival rate.
- Cut CNC `cycleTimeS`: this gains more throughput than speeding up the robot.

**Expected KPIs (8 h)**

| | OEE | Throughput | Good | Bottleneck |
|---|---|---|---|---|
| today (resource ignored) | 0.62 | 115 /h | 888 | CNC-01 |
| with v0.3 engine (estimate) | ≈ 0.45–0.55 | ≈ 85–90 /h | ≈ 680 | CNC-01 / CNC-02, `OP-01` ≈ 100 % utilised |

---

## 2. `assembly-line`: Assembly Line (Three Stations with Day Shift)

```
 ── sub-assembly ──────────────────────────────────┐ ┌── final-assembly ──────────────────────────────────────────────
SRC-01 → CONV-01 → ASM-1 → BUF-01 → ASM-2 ──────────→ BUF-02 → ASM-3 → CONV-02 → EOL-01 → PACK-01 → SNK-01
 48 s     feeder    34 s    cap 6    38 s (BN)        cap 6    32 s    5 m       30 s test  20 s
                    [day]            [day]                     [day]
```

| Asset | Key params |
|---|---|
| SRC-01 Kit Supply | arrival 48 ± 4 s |
| ASM-1 Housing + PCB | cycle 34 ± 3 s, scrap 0.8 %, `shiftId: day` |
| ASM-2 Screwdriving | cycle 38 ± 3 s, MTTR 7 min, scrap 1 %, `shiftId: day` (the bottleneck) |
| ASM-3 Cover + Seal | cycle 32 ± 2 s, `shiftId: day` |
| BUF-01 / BUF-02 | capacity 6 each |
| EOL-01 End-of-Line Functional Test | cycle 30 s, reject 2.5 % |
| PACK-01 Boxing and Labelling | cycle 20 s |
| Calendar | `startHourOfDay` 6; `day` 06–14, `evening` 14–22 |
| Lines | `sub-assembly` (SRC-01 … ASM-2), `final-assembly` (BUF-02 … SNK-01) |

**What it teaches:**
- **Serial bottleneck and buffering.** ASM-2 is the slowest station, so ASM-1 builds WIP in BUF-01 and ASM-3 starves behind it. Shrinking BUF-01 to 1 shows how blocking spreads upstream.
- **Shifts.** The three manual stations work only the day shift. With the v0.3 engine they turn `Off` at 14:00 (sim t = 8 h). Feeder, test and pack are automated and have no shift, so they drain the buffers and then starve. Run past 8 h to see the evening and night Off windows. A what-if can put the stations on `evening` too, or add a second shift.
- **Multi-line KPIs.** `sub-assembly` has no sink, so its throughput is counted at ASM-2, its last asset in flow order.

**Expected KPIs (8 h)**

| | OEE | Throughput | Good | Bottleneck |
|---|---|---|---|---|
| today (shifts ignored) | 0.73 | 66 /h | 554 | ASM-2 |
| with v0.3 engine (estimate) | unchanged, because 06:00–14:00 is inside the day shift | ≈ 66 /h | ≈ 554 | ASM-2 |

---

## 3. `battery-cell-line`: Battery Cell Line (Gigafactory Pouch Cells)

```
 ── electrode ──────────────────────────────────────────┐
SRC-01 → COAT-01 → DRY-01 → CAL-01 → SLIT-01 ───────────┤
 60 s     40 s      45 s     35 s     30 s              │
 ┌──────────────────────────────────────────────────────┘
 │ ── cell-assembly ─────────────────────────────────────────────┐
 └→ BUF-01 ─┬ STK-01 ┬→ ASSY-01 → FILL-01 ──────────────────────┤
    cap 12  └ STK-02 ┘   40 s      45 s                         │
              90 s each                                         │
 ┌──────────────────────────────────────────────────────────────┘
 │ ── formation ───────────────────────────────────────────────────────────────────
 └→ BUF-02 → FORM-01 → BUF-03 → AGE-01 → GRD-01 → PACK-01 → SNK-01
    cap 20   50 s       cap 60   52 s     30 s     20 s
             [FORM-CH]                    [FORM-CH]
```

| Asset | Key params | Sensors (limits) |
|---|---|---|
| COAT-01 Slot-Die Electrode Coater | cycle 40 s, 45 kW, scrap 1 % | temp 64/74 °C, coater vibration 2.8/4.5 mm/s |
| DRY-01 Drying Oven | cycle 45 s, 120 kW (40 kW idle), `ambientC` 90 + rise 40 → 130 °C running | oven temperature 140/150 °C |
| CAL-01 Calendering Press | cycle 35 s, 75 kW, MTBF 6 h | roll vibration 4.5/7.1 mm/s |
| SLIT-01 Electrode Slitter | cycle 30 s | knife vibration 4.5/7.1 mm/s |
| BUF-01 Electrode Roll Store | capacity 12 | level hi 11 |
| STK-01/02 Z-Fold Stacker | cycle 90 s each (45 s combined) | |
| ASSY-01 Tab Weld + Pouch Seal | cycle 40 s, sealer heat rise 32 °C | temp 66/76 °C |
| FILL-01 Electrolyte Filling (Dry Room) | cycle 45 s | temp 46/56 °C |
| BUF-02 Wetting Buffer | capacity 20 | level hi 19 |
| FORM-01 Formation Cycler Rack | effective cycle 50 s per cell, 60 kW, `resourceId: FORM-CH` | temp 48/58 °C |
| BUF-03 Ageing Store | capacity 60 | level hi 59 |
| AGE-01 High-Temperature Ageing Chamber | effective cycle 52 s per cell, holds 45 °C | chamber temp 50/60 °C |
| GRD-01 OCV/IR Grading and Sorting | cycle 30 s, reject 3 %, `resourceId: FORM-CH` | rejects count |
| PACK-01 Cell Tray Packing | cycle 20 s | |
| Resource `FORM-CH` | tool, count 2 (formation and grading cycler channels) | |

**Modelling note.** In a real plant, formation takes about 20 h and ageing takes days, with thousands of cells in process at once. This engine has one part in cycle per asset, so each long step is modelled as a rack whose `cycleTimeS` is its **effective** time per cell, that is, the real cycle divided by its parallel capacity. For example, 20 h ÷ 1440 channels gives 50 s. The large buffers in front (BUF-02 and BUF-03) stand in for wetting and ageing shelf storage. `FORM-CH` represents the cycler channels that formation and OCV/IR grading share. With count 2, it does not constrain the line. Drop it to 1 in a what-if to see grading and formation compete.

**What it teaches:**
- A long, mixed process where the bottleneck is downstream, at formation and ageing (52 s), not at the expensive electrode section.
- Big buffers that hide the front end's disturbances.
- The quality loss that compounds over 12 process steps (line Q ≈ 0.89).
- Per-line KPIs for the electrode, cell-assembly and formation areas.

**Expected KPIs (8 h)**

| | OEE | Throughput | Good | Bottleneck |
|---|---|---|---|---|
| today (resource ignored) | 0.61 | 28–45 /h (last-hour figure is 28 /h; the 8 h average is 45 /h) | 362 | AGE-01, then FORM-01 |
| with v0.3 engine (estimate) | unchanged, because FORM-CH count 2 never binds | ≈ same | ≈ 362 | AGE-01 / FORM-01 |

---

## Adding a template

1. Add `<id>.json` and `<id>.meta.json` to `contracts/plant/templates/`.
2. Add the id to `TemplateTests.TemplateIds`.
3. The tests check:
   - ids, references and reachability
   - lines, resources and shifts
   - footprint overlaps
   - sensor limits
   - an 8 h run, with OEE in [0.3, 0.9] and a run time under 2 s

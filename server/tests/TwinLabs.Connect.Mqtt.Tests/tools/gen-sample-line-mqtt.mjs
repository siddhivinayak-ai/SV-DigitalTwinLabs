// Generates contracts/plant/sample_line.mqtt.json from contracts/plant/sample_line.json.
// Usage (from the repo root): node server/tests/TwinLabs.Connect.Mqtt.Tests/tools/gen-sample-line-mqtt.mjs
// Topic rule (mirrors TwinLabs.Connect.Mqtt.MqttTopics; SampleLineMqttTests checks they agree):
//   <lineId-lowercase>/<assetId>/<name-lowercase>, lineId = plant id minus "-connected", split on -/_, PascalCased.
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
const src = join(root, "contracts", "plant", "sample_line.json");
const dst = join(root, "contracts", "plant", "sample_line.mqtt.json");

const plant = JSON.parse(readFileSync(src, "utf8"));
const id = "line-a-connected";

const lineId = (plantId) =>
  plantId
    .replace(/-connected$/i, "")
    .split(/[-_]/)
    .filter((p) => p.length > 0)
    .map((p) => p[0].toUpperCase() + p.slice(1))
    .join("");
const prefix = lineId(id).toLowerCase();
const suffix = (sensorId) => sensorId.slice(sensorId.lastIndexOf(".") + 1).toLowerCase();

const conn = "broker";
const bindings = [];
for (const a of plant.assets) {
  for (const f of ["state", "good", "scrap", "wip", "load", "wear"]) {
    bindings.push({ target: `asset:${a.id}.${f}`, connectionId: conn, address: `${prefix}/${a.id}/${f}`, jsonPath: "$.value" });
  }
}
for (const s of plant.sensors) {
  bindings.push({ target: `sensor:${s.id}`, connectionId: conn, address: `${prefix}/${s.assetId}/${suffix(s.id)}`, jsonPath: "$.value" });
}

const out = {
  ...plant,
  id,
  name: "Line A (connected over MQTT)",
  connections: [{ id: conn, kind: "mqtt", endpoint: "mqtt://localhost:1883", clientId: "twinlabs" }],
  bindings,
};
writeFileSync(dst, JSON.stringify(out, null, 2) + "\n");
console.log(`wrote ${dst}: ${bindings.length} bindings`);

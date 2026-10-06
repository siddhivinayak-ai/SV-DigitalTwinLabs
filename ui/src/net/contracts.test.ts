import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ASSET_STATES, type PlantModel, type ServerMessage, type ClientMessage } from './contracts';

const dir = resolve(__dirname, '../../../contracts');
const load = (rel: string) => JSON.parse(readFileSync(resolve(dir, rel), 'utf8'));

const SERVER_TYPES = ['snapshot', 'tick', 'event', 'alarm', 'kpi', 'params', 'ack'];

describe('contracts/examples', () => {
  const files = readdirSync(resolve(dir, 'examples')).filter((f) => f.endsWith('.json'));

  it.each(files)('%s parses', (file) => {
    const json = load(`examples/${file}`);
    if (file.startsWith('command.')) {
      const msg = json as ClientMessage;
      expect(msg.type).toBe('command');
      expect(msg.data.action).toMatch(/^(sim|asset|alarm)\./);
    } else if ('type' in json) {
      const msg = json as ServerMessage;
      expect(SERVER_TYPES).toContain(msg.type);
      expect(typeof msg.t).toBe('number');
      expect(typeof msg.seq).toBe('number');
    } else {
      expect(json).toBeTypeOf('object');
    }
  });

  it('tick states are known', () => {
    const msg = load('examples/tick.json') as ServerMessage;
    if (msg.type !== 'tick') throw new Error('expected tick');
    for (const a of msg.data.assets) expect(ASSET_STATES).toContain(a.state);
  });

  it('sample line is consistent', () => {
    const plant = load('plant/sample_line.json') as PlantModel;
    const ids = new Set(plant.assets.map((a) => a.id));
    expect(plant.assets).toHaveLength(11);
    for (const a of plant.assets) for (const d of a.downstream) expect(ids.has(d)).toBe(true);
    for (const s of plant.sensors) expect(ids.has(s.assetId)).toBe(true);
  });
});

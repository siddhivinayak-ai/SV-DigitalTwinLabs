// Command helpers shared by the tool strip, menus, panels and dialogs.
import type { AckData, CommandData } from '../net/contracts';
import type { TwinSource } from '../net/source';
import { postStatus } from './status';

/** Send a command, report the outcome in the status bar, resolve with the ack (or a synthetic failure). */
export async function runCommand(source: TwinSource, cmd: Omit<CommandData, 'id'>, label?: string): Promise<AckData> {
  const what = label ?? describeCommand(cmd);
  try {
    const ack = await source.command(cmd);
    if (ack.ok) postStatus(`${what} — OK`, 'ok');
    else postStatus(`${what} — rejected: ${ack.error ?? 'unknown error'}`, 'error');
    return ack;
  } catch (e) {
    const msg = (e as Error)?.message ?? String(e);
    postStatus(`${what} — failed: ${msg}`, 'error');
    return { commandId: '', ok: false, error: msg };
  }
}

export function describeCommand(cmd: Omit<CommandData, 'id'>): string {
  switch (cmd.action) {
    case 'sim.start': return 'Start simulation';
    case 'sim.pause': return 'Pause simulation';
    case 'sim.stop': return 'Stop simulation';
    case 'sim.reset': return 'Reset simulation';
    case 'sim.speed': return `Set speed ×${cmd.value}`;
    case 'asset.params': return `Update ${cmd.assetId} parameters`;
    case 'asset.fault': return `Inject fault on ${cmd.assetId}`;
    case 'asset.clearFault': return `Clear fault on ${cmd.assetId}`;
    case 'asset.maintenance': return `${cmd.value ? 'Begin' : 'End'} maintenance on ${cmd.assetId}`;
    case 'asset.enable': return `${cmd.value ? 'Enable' : 'Disable'} ${cmd.assetId}`;
    case 'alarm.ack': return `Acknowledge ${cmd.alarmId}`;
  }
}

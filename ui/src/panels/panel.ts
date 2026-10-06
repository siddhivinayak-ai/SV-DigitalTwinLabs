import type { TwinSource } from '../net/source';
import type { TwinStore } from '../state/store';

export interface PanelContext {
  store: TwinStore;
  source: TwinSource;
}

/**
 * A dockable pane. The shell creates it, calls mount() once with an empty host element
 * that fills the pane body, resize() whenever the pane changes size, dispose() on teardown.
 * Panels must unsubscribe all store listeners in dispose().
 */
export interface Panel {
  readonly id: string;
  readonly title: string;
  mount(host: HTMLElement): void;
  resize?(width: number, height: number): void;
  dispose(): void;
}

export type PanelFactory = (ctx: PanelContext) => Panel;

/** Temporary placeholder used until the owning branch lands. */
export function placeholderPanel(id: string, title: string): Panel {
  return {
    id,
    title,
    mount(host) {
      host.textContent = `${title} — pending`;
      host.style.cssText = 'display:flex;align-items:center;justify-content:center;color:#808080;font:11px Tahoma,sans-serif';
    },
    dispose() {},
  };
}

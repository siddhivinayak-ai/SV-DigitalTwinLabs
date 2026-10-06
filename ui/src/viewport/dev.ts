import type { TwinStore } from '../state/store';

/**
 * TEMPORARY dev hook for screenshots / manual testing (owned by the viewport, harmless in production):
 *   ?devTheme=dark       switch the theme once all panels are mounted
 *   ?devSelect=CNC-01    select an asset once the first snapshot arrived
 *   ?devFocus=CNC-01     frame the camera on an asset (as double-click does)
 */
export function applyDevParams(store: TwinStore, focus?: (id: string) => void): void {
  if (typeof location === 'undefined') return;
  const q = new URLSearchParams(location.search);
  const theme = q.get('devTheme');
  const sel = q.get('devSelect');
  const foc = q.get('devFocus');
  if (theme === 'dark' || theme === 'light') setTimeout(() => store.setTheme(theme), 0);
  if (sel || foc) {
    const apply = () => {
      if (sel && store.assetDef(sel)) store.select(sel);
      if (foc && store.assetDef(foc)) focus?.(foc);
    };
    if (store.plant) setTimeout(apply, 0);
    else { const off = store.on('snapshot', () => { off(); setTimeout(apply, 0); }); }
  }
}

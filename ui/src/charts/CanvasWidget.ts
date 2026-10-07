/**
 * Base for the small canvas instruments (gauge, bar meter, sparkline): DPR-correct sizing via a
 * ResizeObserver on its own element, and coalesced redraws (at most one per animation frame).
 */
export abstract class CanvasWidget {
  readonly el: HTMLCanvasElement;
  protected readonly ctx: CanvasRenderingContext2D;
  protected w = 0;
  protected h = 0;
  protected pr = 1;
  private raf = 0;
  private readonly ro: ResizeObserver;

  constructor(host: HTMLElement, className: string) {
    this.el = document.createElement('canvas');
    this.el.className = className;
    host.appendChild(this.el);
    this.ctx = this.el.getContext('2d')!;
    this.ro = new ResizeObserver(() => this.measure());
    this.ro.observe(this.el);
  }

  private measure(): void {
    const r = this.el.getBoundingClientRect();
    const pr = Math.min(3, window.devicePixelRatio || 1);
    const w = Math.round(r.width), h = Math.round(r.height);
    if (w === this.w && h === this.h && pr === this.pr) return;
    this.w = w; this.h = h; this.pr = pr;
    this.el.width = Math.max(1, Math.round(w * pr));
    this.el.height = Math.max(1, Math.round(h * pr));
    this.paint();
  }

  /** Request a redraw on the next animation frame. */
  invalidate(): void {
    if (this.raf) return;
    this.raf = requestAnimationFrame(() => { this.raf = 0; this.paint(); });
  }

  private paint(): void {
    if (this.w < 2 || this.h < 2) return;
    const c = this.ctx;
    c.setTransform(this.pr, 0, 0, this.pr, 0, 0);
    c.clearRect(0, 0, this.w, this.h);
    this.draw(c, this.w, this.h);
  }

  /** Draw in CSS pixels. */
  protected abstract draw(c: CanvasRenderingContext2D, w: number, h: number): void;

  dispose(): void {
    cancelAnimationFrame(this.raf);
    this.ro.disconnect();
    this.el.remove();
  }
}

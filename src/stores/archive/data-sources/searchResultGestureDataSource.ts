/** Pointer listeners/timers are DOM lifecycle handles, never component or Pinia state. */
interface GestureCallbacks {
  start: (x: number, y: number) => void;
  move: (x: number, y: number) => void;
  finish: () => void;
  cancel: () => void;
}
let active: { id: string; release: () => void; cancel: () => void } | undefined;
let suppressedId: string | undefined;
let suppressionTimer: ReturnType<typeof setTimeout> | undefined;
export const searchResultGestureDataSource = {
  begin(id: string, event: PointerEvent, callbacks: GestureCallbacks) {
    if (event.button !== 0) return;
    this.cancel();
    const startX = event.clientX;
    const startY = event.clientY;
    let dragging = false;
    const release = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', finish);
      window.removeEventListener('pointercancel', cancel);
      active = undefined;
    };
    const move = (next: PointerEvent) => {
      if (!dragging) {
        if (Math.abs(next.clientX - startX) < 5 && Math.abs(next.clientY - startY) < 5) return;
        dragging = true;
        callbacks.start(next.clientX, next.clientY);
      }
      callbacks.move(next.clientX, next.clientY);
    };
    const finish = () => {
      release();
      if (dragging) {
        suppressedId = id;
        if (suppressionTimer) clearTimeout(suppressionTimer);
        suppressionTimer = setTimeout(() => { suppressedId = undefined; suppressionTimer = undefined; }, 0);
        callbacks.finish();
      }
    };
    const cancel = () => { release(); if (dragging) callbacks.cancel(); };
    active = { id, release, cancel };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', finish);
    window.addEventListener('pointercancel', cancel);
  },
  consumeClick(id: string): boolean {
    if (suppressedId !== id) return false;
    suppressedId = undefined;
    return true;
  },
  release(id: string) { if (active?.id === id) active.cancel(); },
  cancel() { active?.cancel(); },
};

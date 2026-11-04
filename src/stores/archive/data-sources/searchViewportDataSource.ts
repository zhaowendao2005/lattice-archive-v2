/** DOM-only lifecycle bridge. Viewport state belongs to aggregateSearchStore. */
function createViewportBridge() {
  let element: HTMLElement | null = null;
  let observer: ResizeObserver | undefined;
  let frame = 0;
  let listener: (() => void) | undefined;
  return {
    bind(target: HTMLElement | null, update: (top: number, height: number) => void) {
      if (target === element) return;
      this.release();
      element = target;
      if (!target) return;
      listener = () => {
        if (frame) return;
        frame = requestAnimationFrame(() => {
          frame = 0;
          if (element) update(element.scrollTop, element.clientHeight);
        });
      };
      target.addEventListener('scroll', listener, { passive: true });
      observer = new ResizeObserver(listener);
      observer.observe(target);
      update(target.scrollTop, target.clientHeight);
    },
    focusKeywordInput() { document.querySelector<HTMLInputElement>('[data-search-keyword]')?.focus(); },
    focusSizeInput(field: 'min' | 'max') { document.querySelector<HTMLInputElement>(`[data-search-${field}-size]`)?.focus(); },
    reset() { if (element) element.scrollTop = 0; },
    release() {
      if (frame) cancelAnimationFrame(frame);
      if (element && listener) element.removeEventListener('scroll', listener);
      observer?.disconnect();
      observer = undefined;
      element = null;
      listener = undefined;
      frame = 0;
    },
  };
}
export const searchViewportDataSource = createViewportBridge();
export const searchScopeViewportDataSource = createViewportBridge();

/**
 * What the map needs to mount under jsdom, for tests that open Studio's home page
 * without examining the landscape: a 2D context that accepts every call and draws
 * nothing, Path2D, a resize observer that never fires, and reduced motion, so the
 * map paints once and stops. Map behaviour itself is tested in isometric-ui.test.ts.
 */
export function installMapShims(window: Window & typeof globalThis): void {
  const quiet = <T extends object>(target: T): T => new Proxy(target, { get: (object, key) => key in object ? object[key as keyof T] : () => {} });
  const gradient = () => ({ addColorStop() {} });
  const context = quiet({
    measureText: (text: string) => ({ width: text.length * 7, actualBoundingBoxLeft: 0, actualBoundingBoxRight: text.length * 7, actualBoundingBoxAscent: 10, actualBoundingBoxDescent: 3 }),
    createLinearGradient: gradient,
    createRadialGradient: gradient,
  });
  window.HTMLCanvasElement.prototype.getContext = (() => context) as unknown as typeof HTMLCanvasElement.prototype.getContext;
  const values: Readonly<Record<string, unknown>> = {
    // jsdom's own image element; without a resource loader its icons never load, which the map tolerates.
    Image: window.Image,
    Path2D: class { constructor() { return quiet(this); } },
    ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
    matchMedia: () => ({ matches: true, media: "", addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} }),
  };
  for (const [name, value] of Object.entries(values)) {
    Object.defineProperty(window, name, { configurable: true, value });
    Object.defineProperty(globalThis, name, { configurable: true, value });
  }
}

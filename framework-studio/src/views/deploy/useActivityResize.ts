import { useLayoutEffect, useRef, useState, type PointerEvent, type RefObject } from "react";

/** Presentation only: the shared shell length also keeps the map stationary. */
export function useActivityResize({ drawer, bar, open }: {
  drawer: RefObject<HTMLDivElement | null>;
  bar: RefObject<HTMLDivElement | null>;
  open: boolean;
}) {
  const [height, setHeight] = useState<number>();
  const [observedHeight, setObservedHeight] = useState(0);
  const [limits, setLimits] = useState({ min: 120, max: 340 });
  const root = useRef<HTMLElement | null>(null);
  const gesture = useRef<{ id: number; y: number; height: number; moved: boolean } | undefined>(undefined);

  useLayoutEffect(() => {
    const element = drawer.current;
    const header = bar.current;
    if (!element || !header) return;
    const shell = element.closest<HTMLElement>('[data-ui="shell"]') ?? element;
    root.current = shell;
    const properties = ["--activity-drawer", "--activity-bar-height", "--activity-slot-max"];
    const previous = properties.map(name => shell.style.getPropertyValue(name));
    const measure = () => {
      const navigation = shell.querySelector('[data-ui="bar"]');
      const shellHeight = shell.getBoundingClientRect().height;
      const barHeight = header.getBoundingClientRect().height;
      shell.style.setProperty("--activity-bar-height", `${barHeight}px`);
      // Keep the hidden workspace's toolbar laid out when the tray covers it.
      // This reservation does not limit the tray, which can fill the window.
      const belowNavigation = Math.max(0, shellHeight - (navigation?.getBoundingClientRect().height ?? 0));
      const slotMax = Math.min(belowNavigation, Math.max(barHeight + 1, belowNavigation - 200));
      shell.style.setProperty("--activity-slot-max", `${slotMax}px`);
      const max = Math.max(0, Math.floor(shellHeight - barHeight - 1));
      setLimits(previous => previous.max === max ? previous : { min: Math.min(120, max), max });
      setObservedHeight(element.firstElementChild?.getBoundingClientRect().height ?? 0);
    };
    measure();
    const observer = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(measure);
    observer?.observe(shell);
    observer?.observe(header);
    if (element.firstElementChild) observer?.observe(element.firstElementChild);
    const navigation = shell.querySelector('[data-ui="bar"]');
    if (navigation) observer?.observe(navigation);
    return () => {
      observer?.disconnect();
      shell.removeAttribute("data-activity-resizing");
      properties.forEach((name, index) => {
        if (previous[index]) shell.style.setProperty(name, previous[index]);
        else shell.style.removeProperty(name);
      });
      root.current = null;
    };
  }, [bar, drawer]);

  useLayoutEffect(() => {
    if (height !== undefined) root.current?.style.setProperty("--activity-drawer", `${Math.max(limits.min, Math.min(limits.max, height))}px`);
  }, [height, limits]);

  const resize = (value: number) => setHeight(Math.max(limits.min, Math.min(limits.max, value)));
  const finish = () => {
    gesture.current = undefined;
    root.current?.removeAttribute("data-activity-resizing");
  };
  const pointer = {
    onPointerDown(event: PointerEvent<HTMLElement>) {
      if (!open || event.button !== 0 || !event.isPrimary) return;
      gesture.current = { id: event.pointerId, y: event.clientY, height: drawer.current?.getBoundingClientRect().height ?? 0, moved: false };
      event.currentTarget.setPointerCapture(event.pointerId);
    },
    onPointerMove(event: PointerEvent<HTMLElement>) {
      const start = gesture.current;
      if (!start || start.id !== event.pointerId) return;
      const delta = start.y - event.clientY;
      if (!start.moved && Math.abs(delta) < 4) return;
      if (!start.moved) {
        start.moved = true;
        root.current?.setAttribute("data-activity-resizing", "");
      }
      resize(start.height + delta);
    },
    onPointerUp(event: PointerEvent<HTMLElement>) {
      if (gesture.current?.id !== event.pointerId) return;
      finish();
      if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    },
    onPointerCancel: finish,
    onLostPointerCapture: finish,
  };

  return {
    pointer,
    min: limits.min,
    max: limits.max,
    height: Math.max(limits.min, Math.min(limits.max, height ?? observedHeight)),
    resizeByKey(key: string) {
      if (!open || !["ArrowUp", "ArrowDown", "Home", "End"].includes(key)) return false;
      const current = drawer.current?.getBoundingClientRect().height ?? limits.min;
      resize(key === "Home" ? limits.min : key === "End" ? limits.max : current + (key === "ArrowUp" ? 24 : -24));
      return true;
    },
  };
}

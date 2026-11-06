import { useLayoutEffect, useRef, useState, type MouseEvent, type PointerEvent, type RefObject } from "react";

/** Presentation only: the shared shell length also keeps the map stationary. */
export function useActivityResize({ drawer, bar, open, onExpand, onCollapse }: {
  drawer: RefObject<HTMLDivElement | null>;
  bar: RefObject<HTMLDivElement | null>;
  open: boolean;
  onExpand: () => void;
  onCollapse: () => void;
}) {
  const [height, setHeight] = useState<number>();
  const [observedHeight, setObservedHeight] = useState(0);
  const [limits, setLimits] = useState({ min: 100, max: 340 });
  const root = useRef<HTMLElement | null>(null);
  const resetOnOpen = useRef(false);
  const suppressClick = useRef(false);
  const gesture = useRef<{
    id: number; y: number; height: number; value: number; moved: boolean; opening: boolean;
    target: HTMLElement; capture: HTMLElement;
  } | undefined>(undefined);

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
      setLimits(previous => previous.max === max ? previous : { min: Math.min(100, max), max });
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
    if (height !== undefined) root.current?.style.setProperty("--activity-drawer", `${Math.max(gesture.current?.opening ? 0 : limits.min, Math.min(limits.max, height))}px`);
  }, [height, limits]);

  useLayoutEffect(() => {
    if (!open || !resetOnOpen.current) return;
    resetOnOpen.current = false;
    setHeight(undefined);
    // Reset only on reopening so the closing slide starts at the dragged height.
    root.current?.style.removeProperty("--activity-drawer");
  }, [open]);

  const resize = (value: number) => setHeight(Math.max(limits.min, Math.min(limits.max, value)));
  const finish = () => {
    gesture.current = undefined;
    root.current?.removeAttribute("data-activity-resizing");
  };
  const collapse = () => {
    finish();
    resetOnOpen.current = true;
    onCollapse();
  };
  const release = (event: PointerEvent<HTMLElement>) => {
    const start = gesture.current;
    if (!start || start.id !== event.pointerId || start.target !== event.currentTarget) return;
    if (start.moved && start.value < limits.min) collapse();
    else finish();
    if (start.capture.hasPointerCapture(event.pointerId)) start.capture.releasePointerCapture(event.pointerId);
  };
  const pointer = {
    onPointerDown(event: PointerEvent<HTMLElement>) {
      suppressClick.current = false;
      const fromBar = event.currentTarget === bar.current;
      if (fromBar === open || event.button !== 0 || !event.isPrimary) return;
      const control = (event.target as Element).closest<HTMLElement>("button, a, input, select, textarea");
      if (fromBar && control && control.getAttribute("aria-controls") !== "studio-activity-drawer") return;
      const value = open ? drawer.current?.getBoundingClientRect().height ?? 0 : 0;
      // Capture on the toggle itself so a press without a drag still clicks it.
      const capture = fromBar ? control ?? event.currentTarget : event.currentTarget;
      gesture.current = { id: event.pointerId, y: event.clientY, height: value, value, moved: false, opening: !open, target: event.currentTarget, capture };
      capture.setPointerCapture(event.pointerId);
    },
    onPointerMove(event: PointerEvent<HTMLElement>) {
      const start = gesture.current;
      if (!start || start.id !== event.pointerId || start.target !== event.currentTarget) return;
      const delta = start.y - event.clientY;
      if (!start.moved && (Math.abs(delta) < 4 || start.opening && delta < 0)) return;
      if (!start.moved) {
        start.moved = true;
        suppressClick.current = true;
        root.current?.setAttribute("data-activity-resizing", "");
        if (start.opening) {
          resetOnOpen.current = false;
          onExpand();
        }
      }
      const next = Math.max(0, Math.min(limits.max, start.height + delta));
      start.value = next;
      if (!start.opening && next < limits.min) {
        resize(limits.min);
        collapse();
        return;
      }
      if (next >= limits.min) start.opening = false;
      setHeight(next);
    },
    onPointerUp: release,
    onPointerCancel: release,
    onLostPointerCapture: release,
    onClickCapture(event: MouseEvent<HTMLElement>) {
      if (suppressClick.current && event.detail > 0) {
        event.preventDefault();
        event.stopPropagation();
      }
      suppressClick.current = false;
    },
  };

  return {
    pointer,
    min: gesture.current?.opening ? 0 : limits.min,
    max: limits.max,
    height: Math.max(gesture.current?.opening ? 0 : limits.min, Math.min(limits.max, height ?? observedHeight)),
    resizeByKey(key: string) {
      if (!open || !["ArrowUp", "ArrowDown", "Home", "End"].includes(key)) return false;
      const current = drawer.current?.getBoundingClientRect().height ?? limits.min;
      resize(key === "Home" ? limits.min : key === "End" ? limits.max : current + (key === "ArrowUp" ? 24 : -24));
      return true;
    },
  };
}

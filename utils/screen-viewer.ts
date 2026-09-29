import { computed, ref, watch } from "vue";

export type ScreenInputAction =
  | "click" | "move" | "down" | "up"
  | "double_click" | "right_click" | "middle_click";

export interface ScreenViewerPoint {
  x: number;
  y: number;
}

export interface ScreenViewerRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

interface TouchPoint {
  clientX: number;
  clientY: number;
}

export type ScreenViewerMeasure = () => Promise<ScreenViewerRect>;

interface ViewerGesture {
  mode: "pan" | "pinch" | "remote" | "mouse" | null;
  startPoints: TouchPoint[];
  startDistance: number;
  startZoom: number;
  startMidpoint: TouchPoint;
  startPan: ScreenViewerPoint;
  totalDistance: number;
}

const localPoint = (viewport: ScreenViewerRect, point: TouchPoint) => ({
  x: point.clientX - viewport.left - viewport.width / 2,
  y: point.clientY - viewport.top - viewport.height / 2,
});

const animationStyle = (enabled: boolean) => enabled
  ? "width 180ms ease-out, height 180ms ease-out, transform 180ms ease-out"
  : "none";

const distance = (a: TouchPoint, b: TouchPoint) => (
  Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY)
);

const midpoint = (points: TouchPoint[]): TouchPoint => ({
  clientX: (points[0].clientX + points[1].clientX) / 2,
  clientY: (points[0].clientY + points[1].clientY) / 2,
});

const eventPoints = (event: any): TouchPoint[] => {
  // TouchList is iterable on native/H5 but is not an Array in uni-app events.
  const source = event?.touches?.length
    ? event.touches
    : event?.changedTouches?.length
      ? event.changedTouches
      : [event];
  return Array.from(source as ArrayLike<any>, (point: any) => ({
    clientX: Number(point?.clientX ?? point?.pageX ?? point?.detail?.x ?? point?.x),
    clientY: Number(point?.clientY ?? point?.pageY ?? point?.detail?.y ?? point?.y),
  }))
    .filter((point: TouchPoint) => Number.isFinite(point.clientX) && Number.isFinite(point.clientY));
};

export const createScreenViewer = (options: {
  frameWidth: () => number;
  frameHeight: () => number;
  active: () => boolean;
  measure: ScreenViewerMeasure;
  sendInput: (action: ScreenInputAction, point: ScreenViewerPoint) => Promise<void>;
  onError?: (message: string) => void;
}) => {
  const fitZoom = ref(1);
  const zoom = ref(1);
  const pan = ref<ScreenViewerPoint>({ x: 0, y: 0 });
  const inputMode = ref<"mouse" | "touch">("mouse");
  const cursor = ref<ScreenViewerPoint | null>(null);
  const animating = ref(false);
  const viewport = ref<ScreenViewerRect | null>(null);
  let gesture: ViewerGesture | null = null;
  let remoteActive = false;
  let mouseDragging = false;
  let mouseDragTimer: ReturnType<typeof setTimeout> | null = null;
  let animationTimer: ReturnType<typeof setTimeout> | null = null;

  const normalizeZoom = (value: number) => {
    const minZoom = Math.min(0.2, 1 / Math.max(1, fitZoom.value));
    return Math.max(minZoom, Math.min(6, value));
  };

  const frameWidth = computed(() => Math.max(1, options.frameWidth()));
  const frameHeight = computed(() => Math.max(1, options.frameHeight()));
  const scale = computed(() => fitZoom.value * zoom.value);
  const displayWidth = computed(() => Math.max(1, Math.round(frameWidth.value * scale.value)));
  const displayHeight = computed(() => Math.max(1, Math.round(frameHeight.value * scale.value)));
  const fitActive = computed(() => Math.abs(zoom.value - 1) < 0.001);
  const percentLabel = computed(() => `${Math.round(scale.value * 100)}%`);

  const clampPan = () => {
    const currentViewport = viewport.value;
    if (!currentViewport) return;
    const maxX = Math.max(0, (displayWidth.value - currentViewport.width) / 2);
    const maxY = Math.max(0, (displayHeight.value - currentViewport.height) / 2);
    pan.value = {
      x: Math.max(-maxX, Math.min(maxX, pan.value.x)),
      y: Math.max(-maxY, Math.min(maxY, pan.value.y)),
    };
  };

  const frameStyle = computed(() => ({
    width: `${displayWidth.value}px`,
    height: `${displayHeight.value}px`,
    transition: animationStyle(animating.value),
    transform: `translate3d(calc(-50% + ${Math.round(pan.value.x)}px), calc(-50% + ${Math.round(pan.value.y)}px), 0)`,
  }));

  const ensureCursor = () => {
    if (!cursor.value) {
      cursor.value = { x: frameWidth.value / 2, y: frameHeight.value / 2 };
    }
    cursor.value = {
      x: Math.max(0, Math.min(frameWidth.value, cursor.value.x)),
      y: Math.max(0, Math.min(frameHeight.value, cursor.value.y)),
    };
    return cursor.value;
  };

  const cursorStyle = computed(() => {
    const point = ensureCursor();
    return {
      left: `calc(50% + ${Math.round(pan.value.x + point.x * scale.value)}px)`,
      top: `calc(50% + ${Math.round(pan.value.y + point.y * scale.value)}px)`,
    };
  });

  const startAnimation = () => {
    animating.value = true;
    if (animationTimer != null) clearTimeout(animationTimer);
    animationTimer = setTimeout(() => {
      animationTimer = null;
      animating.value = false;
    }, 220);
  };

  const stopAnimation = () => {
    if (animationTimer != null) {
      clearTimeout(animationTimer);
      animationTimer = null;
    }
    animating.value = false;
  };

  const ensureViewport = async (force = false): Promise<ScreenViewerRect | null> => {
    if (!force && viewport.value && viewport.value.width > 0 && viewport.value.height > 0) {
      return viewport.value;
    }
    try {
      const measured = await options.measure();
      if (measured.width > 0 && measured.height > 0) {
        viewport.value = measured;
        fitZoom.value = Math.min(measured.width / frameWidth.value, measured.height / frameHeight.value);
        clampPan();
        return measured;
      }
    } catch {
      // The page supplies a viewport fallback, so this is only a measurement race.
    }
    return viewport.value;
  };

  const setZoom = (nextZoom: number, anchor?: TouchPoint) => {
    const currentViewport = viewport.value;
    if (!currentViewport) return;
    const next = normalizeZoom(nextZoom);
    if (Math.abs(next - zoom.value) < 0.001) return;

    const center = {
      clientX: currentViewport.left + currentViewport.width / 2,
      clientY: currentViewport.top + currentViewport.height / 2,
    };
    const anchorPoint = anchor || center;
    const local = localPoint(currentViewport, anchorPoint);
    const imageX = (local.x - pan.value.x) / zoom.value;
    const imageY = (local.y - pan.value.y) / zoom.value;
    zoom.value = next;
    pan.value = {
      x: local.x - imageX * next,
      y: local.y - imageY * next,
    };
    clampPan();
  };

  const fit = async () => {
    startAnimation();
    zoom.value = 1;
    pan.value = { x: 0, y: 0 };
    await ensureViewport(true);
  };

  const actualSize = async () => {
    await ensureViewport();
    if (!viewport.value) return;
    startAnimation();
    zoom.value = normalizeZoom(1 / Math.max(0.001, fitZoom.value));
    pan.value = { x: 0, y: 0 };
    clampPan();
  };

  const zoomIn = async (anchor?: TouchPoint) => {
    await ensureViewport();
    if (!viewport.value) return;
    startAnimation();
    setZoom(zoom.value * 1.25, anchor);
  };

  const zoomOut = async (anchor?: TouchPoint) => {
    await ensureViewport();
    if (!viewport.value) return;
    startAnimation();
    setZoom(zoom.value / 1.25, anchor);
  };

  const pointFromEvent = async (event: any): Promise<(ScreenViewerPoint & TouchPoint) | null> => {
    const point = eventPoints(event)[0];
    if (!point) return null;
    const area = await ensureViewport();
    if (!area) return null;
    if (frameWidth.value <= 0 || frameHeight.value <= 0) return null;

    const localX = point.clientX - area.left;
    const localY = point.clientY - area.top;
    const imageX = (localX - area.width / 2 - pan.value.x) / scale.value;
    const imageY = (localY - area.height / 2 - pan.value.y) / scale.value;
    if (imageX < 0 || imageY < 0 || imageX > frameWidth.value || imageY > frameHeight.value) return null;
    return {
      ...point,
      x: Math.max(0, Math.min(frameWidth.value, imageX)),
      y: Math.max(0, Math.min(frameHeight.value, imageY)),
    };
  };

  const sendRemote = async (action: ScreenInputAction, event: any) => {
    if (!options.active()) return false;
    const point = await pointFromEvent(event);
    if (!point) return false;
    try {
      await options.sendInput(action, { x: point.x, y: point.y });
      return true;
    } catch (error: any) {
      options.onError?.(error?.message || "触摸控制不可用");
      return false;
    }
  };

  const sendAtCursor = async (action: ScreenInputAction) => {
    const point = ensureCursor();
    try {
      await options.sendInput(action, { x: point.x, y: point.y });
      return true;
    } catch (error: any) {
      options.onError?.(error?.message || "鼠标控制不可用");
      return false;
    }
  };

  const moveCursor = async (deltaX: number, deltaY: number, send = true) => {
    const point = ensureCursor();
    cursor.value = {
      x: Math.max(0, Math.min(frameWidth.value, point.x + deltaX)),
      y: Math.max(0, Math.min(frameHeight.value, point.y + deltaY)),
    };
    if (send) await sendAtCursor("move");
  };

  // Gesture state must be assigned synchronously. A quick tap can otherwise
  // fire touchend before an awaited viewport measurement finishes, losing the click.
  const beginGesture = (event: any) => {
    if (!options.active()) return;
    const points = eventPoints(event);
    if (!points.length) return;
    stopAnimation();
    if (points.length >= 2) {
      if (remoteActive) {
        remoteActive = false;
        void sendRemote("up", event);
      }
      const [first, second] = points;
      gesture = {
        mode: "pinch",
        startPoints: [first, second],
        startDistance: Math.max(1, distance(first, second)),
        startZoom: zoom.value,
        startMidpoint: midpoint([first, second]),
        startPan: { ...pan.value },
        totalDistance: 0,
      };
      void ensureViewport();
      return;
    }

    if (inputMode.value === "mouse") {
      ensureCursor();
      gesture = {
        mode: "mouse",
        startPoints: [points[0]],
        startDistance: 0,
        startZoom: zoom.value,
        startMidpoint: points[0],
        startPan: { ...pan.value },
        totalDistance: 0,
      };
      if (mouseDragTimer != null) clearTimeout(mouseDragTimer);
      mouseDragTimer = setTimeout(() => {
        mouseDragTimer = null;
        if (gesture?.mode !== "mouse" || mouseDragging) return;
        mouseDragging = true;
        void sendAtCursor("down");
      }, 190);
      void ensureViewport();
      return;
    }

    gesture = {
      mode: "remote",
      startPoints: [points[0]],
      startDistance: 0,
      startZoom: zoom.value,
      startMidpoint: points[0],
      startPan: { ...pan.value },
      totalDistance: 0,
    };
    void ensureViewport();
  };

  const moveGesture = async (event: any) => {
    if (!gesture || !options.active()) return;
    const points = eventPoints(event);
    if (!points.length) return;

    if (gesture.mode === "pinch" && points.length >= 2) {
      await ensureViewport();
      const [first, second] = points;
      const currentDistance = Math.max(1, distance(first, second));
      const currentMidpoint = midpoint([first, second]);
      const nextZoom = gesture.startZoom * (currentDistance / gesture.startDistance);
      setZoom(nextZoom, currentMidpoint);
      pan.value = {
        x: pan.value.x + currentMidpoint.clientX - gesture.startMidpoint.clientX,
        y: pan.value.y + currentMidpoint.clientY - gesture.startMidpoint.clientY,
      };
      clampPan();
      gesture = {
        ...gesture,
        mode: "pinch",
        startPoints: [first, second],
        startDistance: currentDistance,
        startZoom: zoom.value,
        startMidpoint: currentMidpoint,
        startPan: { ...pan.value },
        totalDistance: gesture.totalDistance,
      };
      return;
    }

    if (gesture.mode === "mouse") {
      const current = points[0];
      const deltaX = current.clientX - gesture.startMidpoint.clientX;
      const deltaY = current.clientY - gesture.startMidpoint.clientY;
      gesture.totalDistance += Math.hypot(deltaX, deltaY);
      gesture = { ...gesture, startMidpoint: current };
      const area = await ensureViewport();
      const speedX = area ? Math.max(0.55, Math.min(2.2, frameWidth.value / area.width)) * 1.08 : 1.15;
      const speedY = area ? Math.max(0.55, Math.min(2.2, frameHeight.value / area.height)) * 1.08 : 1.15;
      await moveCursor(deltaX * speedX, deltaY * speedY, mouseDragging);
      return;
    }

    if (gesture.mode === "pan") {
      pan.value = {
        x: gesture.startPan.x + points[0].clientX - gesture.startMidpoint.clientX,
        y: gesture.startPan.y + points[0].clientY - gesture.startMidpoint.clientY,
      };
      clampPan();
      return;
    }

    if (gesture.mode === "remote" && remoteActive) {
      await sendRemote("move", event);
      return;
    }

    if (gesture.mode === "remote" && !remoteActive) {
      const movedDistance = Math.hypot(
        points[0].clientX - gesture.startMidpoint.clientX,
        points[0].clientY - gesture.startMidpoint.clientY,
      );
      if (movedDistance >= 8) {
        remoteActive = true;
        const sent = await sendRemote("down", event);
        if (!sent) remoteActive = false;
      }
    }
  };

  const endGesture = async (event: any) => {
    const points = eventPoints(event);
    if (gesture?.mode === "pinch" && points.length === 1) {
      gesture = {
        mode: "pan",
        startPoints: [points[0]],
        startDistance: 0,
        startZoom: zoom.value,
        startMidpoint: points[0],
        startPan: { ...pan.value },
      };
      return;
    }

    if (gesture?.mode === "remote") {
      const wasRemoteActive = remoteActive;
      remoteActive = false;
      await sendRemote(wasRemoteActive ? "up" : "click", event);
    }
    if (gesture?.mode === "mouse") {
      if (mouseDragTimer != null) {
        clearTimeout(mouseDragTimer);
        mouseDragTimer = null;
      }
      if (mouseDragging) {
        mouseDragging = false;
        await sendAtCursor("up");
      } else if (gesture.totalDistance < 9) {
        await sendAtCursor("click");
      }
    }
    gesture = null;
  };

  const reset = () => {
    stopAnimation();
    gesture = null;
    remoteActive = false;
    if (mouseDragTimer != null) {
      clearTimeout(mouseDragTimer);
      mouseDragTimer = null;
    }
    mouseDragging = false;
    viewport.value = null;
    fitZoom.value = 1;
    zoom.value = 1;
    pan.value = { x: 0, y: 0 };
  };

  const handleViewportChange = async () => {
    const oldFit = fitZoom.value;
    const hadViewport = Boolean(viewport.value);
    await ensureViewport(true);
    if (!viewport.value || !hadViewport || oldFit <= 0) return;
    zoom.value = normalizeZoom(zoom.value * (oldFit / Math.max(0.001, fitZoom.value)));
    clampPan();
  };

  watch([frameWidth, frameHeight], ([nextWidth, nextHeight], [previousWidth, previousHeight]) => {
    if (nextWidth === previousWidth && nextHeight === previousHeight) return;
    if (options.active()) void handleViewportChange();
  });

  return {
    zoom,
    pan,
    inputMode,
    cursor,
    cursorStyle,
    scale,
    displayWidth,
    displayHeight,
    fitActive,
    percentLabel,
    animating,
    frameStyle,
    fit,
    actualSize,
    zoomIn,
    zoomOut,
    beginGesture,
    moveGesture,
    endGesture,
    pointFromEvent,
    moveCursor,
    sendAtCursor,
    reset,
    handleViewportChange,
  };
};

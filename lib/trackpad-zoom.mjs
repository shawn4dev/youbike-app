// Provisional CSS-pixel normalization for cancellable Ctrl+wheel pinch input.
// Ctrl+mouse-wheel is indistinguishable at this boundary. Line/page conversion
// and the outlier cap are numeric safeguards, not measured device sensitivity.
export function normalizePinchDelta(event) {
  if (!event.ctrlKey || event.cancelable !== true || !Number.isFinite(event.deltaY)) return null;
  const factor = [1, 16, 800][event.deltaMode];
  if (factor === undefined) return null;
  return Math.max(-240, Math.min(240, -event.deltaY * factor));
}

export function clampZoom(value, min, max) {
  if (![value, min, max].every(Number.isFinite) || min > max) throw new RangeError('invalid zoom bounds');
  return Math.max(min, Math.min(max, value));
}

// Trial sensitivity: 100 normalized CSS pixels per zoom level, not a claim of
// native hardware equivalence. Rendering uses only public Leaflet APIs.
export function attachTrackpadZoom(map, { onGestureStart = () => {}, onGestureEnd = () => {} } = {}) {
  const container = map.getContainer();
  const document = container.ownerDocument;
  const window = document.defaultView;
  let gesture = null;
  let frame = null;
  let endTimer = null;
  let disposed = false;
  let drawing = false;

  function scheduleEnd() {
    window.clearTimeout(endTimer);
    endTimer = window.setTimeout(() => finish(), 150);
  }

  function draw() {
    frame = null;
    if (!gesture || disposed) return;
    const min = Number.isFinite(map.getMinZoom()) ? map.getMinZoom() : 0;
    const max = Number.isFinite(map.getMaxZoom()) ? map.getMaxZoom() : Math.max(24, min);
    gesture.desiredZoom = clampZoom(gesture.desiredZoom + gesture.delta / 100, min, max);
    gesture.delta = 0;
    const size = map.getSize();
    const offset = { x: gesture.point.x - size.x / 2, y: gesture.point.y - size.y / 2 };
    const center = map.unproject(map.project(gesture.latlng, gesture.desiredZoom).subtract(offset), gesture.desiredZoom);
    drawing = true;
    try { map.flyTo(center, gesture.desiredZoom, { duration: .06 }); }
    finally { drawing = false; }
    scheduleEnd();
  }

  function finish(cancelled = false) {
    if (!gesture) return;
    if (frame !== null) window.cancelAnimationFrame(frame);
    window.clearTimeout(endTimer);
    frame = null;
    endTimer = null;
    const previous = gesture;
    gesture = null;
    // Stop while snap is still zero so cancelling cannot snap the current view.
    if (cancelled) map.stop();
    map.options.zoomSnap = previous.snap;
    if (previous.nativeWheelEnabled) map.scrollWheelZoom.enable();
    onGestureEnd({ cancelled });
  }

  function wheel(event) {
    if (disposed || document.visibilityState === 'hidden') return;
    const delta = normalizePinchDelta(event);
    const excluded = event.target?.closest?.('.leaflet-control, .leaflet-popup, input, textarea, select, button, [contenteditable]');
    if (delta === null || excluded) { finish(true); return; }
    if (delta === 0) return;
    event.preventDefault();
    if (!gesture) {
      gesture = { desiredZoom: map.getZoom(), delta: 0, snap: map.options.zoomSnap,
        nativeWheelEnabled: map.scrollWheelZoom.enabled() };
      map.scrollWheelZoom.disable();
      map.options.zoomSnap = 0;
      onGestureStart();
      drawing = true;
      try { map.stop(); }
      finally { drawing = false; }
    }
    const point = map.mouseEventToContainerPoint(event);
    if (!gesture.point || gesture.point.x !== point.x || gesture.point.y !== point.y) {
      gesture.point = point;
      gesture.latlng = map.containerPointToLatLng(point);
    }
    gesture.delta += delta;
    if (frame === null) frame = window.requestAnimationFrame(draw);
    scheduleEnd();
  }
  const cancel = () => finish(true);
  const visibility = () => { if (document.visibilityState === 'hidden') cancel(); };
  const interrupt = () => { if (!drawing) cancel(); };
  const options = { capture: true, passive: false };
  container.addEventListener('wheel', wheel, options);
  container.addEventListener('pointerdown', cancel, true);
  container.addEventListener('touchstart', cancel, true);
  container.addEventListener('keydown', cancel, true);
  window.addEventListener('blur', cancel);
  document.addEventListener('visibilitychange', visibility);
  map.on('dragstart', cancel);
  map.on('zoomstart movestart', interrupt);
  return () => {
    if (disposed) return;
    finish(true);
    disposed = true;
    container.removeEventListener('wheel', wheel, options);
    container.removeEventListener('pointerdown', cancel, true);
    container.removeEventListener('touchstart', cancel, true);
    container.removeEventListener('keydown', cancel, true);
    window.removeEventListener('blur', cancel);
    document.removeEventListener('visibilitychange', visibility);
    map.off('dragstart', cancel);
    map.off('zoomstart movestart', interrupt);
  };
}

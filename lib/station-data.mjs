export function createStationLoader({ fetchImpl = fetch, onData, onStatus = () => {}, refreshMs = 300000,
  documentImpl = globalThis.document }) {
  const controller = new AbortController();
  let stopped = false;
  let task = null;
  let lastStations = [];
  let lastFetchedAt = null;
  let timer = null;
  let lastAttemptAt = null;
  const isVisible = () => documentImpl?.visibilityState !== 'hidden';
  let visible = isVisible();

  function refresh({ force = false } = {}) {
    if (stopped || !isVisible()) return Promise.resolve();
    if (task) return task;
    // Every actual attempt, including manual refresh or failure, starts a new
    // polling deadline. Returning from a brief background stay keeps that deadline.
    lastAttemptAt = Date.now();
    pauseTimer();
    onStatus(true);
    task = (async () => {
      try {
        const response = await fetchImpl(`/api/stations${force ? '?force=1' : ''}`, {
          cache: 'no-store', signal: controller.signal,
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const data = await response.json();
        if (!Array.isArray(data.stations)) throw new Error('站點資料格式錯誤');
        if (stopped) return;
        lastStations = data.stations;
        lastFetchedAt = data.fetchedAt;
        onData({ ...data, updatedStations: data.stations });
      } catch {
        if (!stopped) onData({
          stations: lastStations, updatedStations: [],
          errors: ['三市站點資料更新失敗，保留上次資料'], fetchedAt: lastFetchedAt,
        });
      } finally {
        if (!stopped) onStatus(false);
        task = null;
        startTimer();
      }
    })();
    return task;
  }

  function pauseTimer() {
    if (timer !== null) clearTimeout(timer);
    timer = null;
  }
  function startTimer() {
    if (stopped || !isVisible() || task || timer !== null || refreshMs <= 0) return;
    const remaining = lastAttemptAt === null ? refreshMs : Math.max(0, lastAttemptAt + refreshMs - Date.now());
    timer = setTimeout(() => { timer = null; void refresh(); }, remaining);
  }
  function onVisibilityChange() {
    if (stopped) return;
    const nextVisible = isVisible();
    if (nextVisible === visible) return;
    visible = nextVisible;
    if (!visible) pauseTimer();
    else {
      if (lastAttemptAt === null || Date.now() - lastAttemptAt >= refreshMs) void refresh();
      startTimer();
    }
  }
  documentImpl?.addEventListener('visibilitychange', onVisibilityChange);
  if (visible) startTimer();
  return {
    refresh,
    whenIdle: async () => { await task; },
    stop: () => {
      stopped = true;
      controller.abort();
      pauseTimer();
      documentImpl?.removeEventListener('visibilitychange', onVisibilityChange);
    },
  };
}

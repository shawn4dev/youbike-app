export function createStationLoader({ fetchImpl = fetch, onData, onStatus = () => {}, refreshMs = 300000,
  documentImpl = globalThis.document, initialRequest = null }) {
  const controller = new AbortController();
  let stopped = false;
  let task = null;
  let activeForce = false;
  let pendingForce = null;
  let resumeForce = null;
  let discardActive = false;
  let activeBootstrap = null;
  let lastStations = [];
  let lastFetchedAt = null;
  let timer = null;
  let lastAttemptAt = null;
  const isVisible = () => documentImpl?.visibilityState !== 'hidden';
  let visible = isVisible();

  function refresh({ force = false } = {}) {
    if (stopped) return Promise.resolve();
    if (force && pendingForce) return pendingForce;
    if (!isVisible()) return force && activeForce && task ? task : Promise.resolve();
    if (task) {
      if (!force || activeForce) return task;
      discardActive = true;
      activeBootstrap?.cancel();
      initialRequest?.cancel();
      initialRequest = null;
      pendingForce = task.then(async () => {
        if (!stopped && !isVisible()) await new Promise(resolve => { resumeForce = resolve; });
        const queued = pendingForce;
        pendingForce = null;
        const forced = stopped ? undefined : refresh({ force: true });
        pendingForce = queued;
        return forced;
      }).finally(() => {
        pendingForce = null;
        startTimer();
      });
      return pendingForce;
    }
    if (force) {
      initialRequest?.cancel();
      initialRequest = null;
    }
    const bootstrap = initialRequest;
    activeBootstrap = bootstrap;
    initialRequest = null;
    activeForce = force;
    discardActive = false;
    lastAttemptAt = bootstrap
      ? Date.now() - Math.max(0, performance.now() - bootstrap.startedAtMono) : Date.now();
    pauseTimer();
    onStatus(true);
    task = (async () => {
      try {
        const early = bootstrap ? await bootstrap.result : null;
        if (stopped || discardActive) return;
        let data = early?.payload;
        if (!data || !Number.isFinite(early.expiresAtMono) || early.expiresAtMono <= performance.now()) {
          bootstrap?.cancel();
          lastAttemptAt = Date.now();
          const response = await fetchImpl(`/api/stations${force ? '?force=1' : ''}`, {
            cache: 'no-store', signal: controller.signal,
          });
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          data = await response.json();
        }
        if (!Array.isArray(data.stations)) throw new Error('站點資料格式錯誤');
        if (stopped || discardActive) return;
        lastStations = data.stations;
        lastFetchedAt = data.fetchedAt;
        onData({ ...data, updatedStations: data.stations });
      } catch {
        if (!stopped && !discardActive) onData({
          stations: lastStations, updatedStations: [],
          errors: ['三市站點資料更新失敗，保留上次資料'], fetchedAt: lastFetchedAt,
        });
      } finally {
        activeBootstrap = null;
        if (!stopped) onStatus(false);
        task = null;
        activeForce = false;
        if (!pendingForce) startTimer();
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
      if (pendingForce) {
        resumeForce?.();
        resumeForce = null;
        return;
      }
      if (lastAttemptAt === null || Date.now() - lastAttemptAt >= refreshMs) void refresh();
      startTimer();
    }
  }
  documentImpl?.addEventListener('visibilitychange', onVisibilityChange);
  if (visible) startTimer();
  return {
    refresh,
    whenIdle: async () => { await (pendingForce || task); },
    stop: () => {
      stopped = true;
      resumeForce?.();
      resumeForce = null;
      controller.abort();
      activeBootstrap?.cancel();
      initialRequest?.cancel();
      initialRequest = null;
      pauseTimer();
      documentImpl?.removeEventListener('visibilitychange', onVisibilityChange);
    },
  };
}

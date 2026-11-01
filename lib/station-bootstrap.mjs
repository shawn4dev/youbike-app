// A literal keeps the parser-time script independent of bundler renaming.
export const stationBootstrapScript = `(function(){
  if (document.visibilityState === 'hidden') return;
  var slot = '__ybStationBootstrap';
  if (window[slot]) return;
  var controller = new AbortController();
  var startedAtMono = performance.now();
  var claimed = false;
  var cancelled = false;
  var value = null;
  var expiry = null;
  var timeout = null;
  var settle;
  var result = new Promise(function(resolve){ settle = resolve; });
  function detach(){
    document.removeEventListener('visibilitychange', hidden);
    window.removeEventListener('pagehide', cancel);
    clearTimeout(expiry);
  }
  function cancel(){
    cancelled = true;
    controller.abort();
    clearTimeout(timeout);
    detach();
    if (value) value.payload = null;
    if (window[slot] === handle) delete window[slot];
    settle(null);
  }
  function hidden(){ if (document.visibilityState === 'hidden') cancel(); }
  var handle = { result: result, startedAtMono: startedAtMono, cancel: cancel,
    claim: function(){ claimed = true; detach(); } };
  document.addEventListener('visibilitychange', hidden);
  window.addEventListener('pagehide', cancel);
  timeout = setTimeout(cancel, 15000);
  window[slot] = handle;
  Promise.resolve().then(function(){
    if (cancelled) return null;
    return fetch('/api/stations', { cache: 'no-store', signal: controller.signal });
  }).then(function(response){
    if (!response || !response.ok) throw new Error('station response');
    return response.json();
  }).then(function(payload){
    clearTimeout(timeout);
    var budget = payload && payload.freshForMs;
    if (cancelled || !Array.isArray(payload.stations) || !payload.stations.length ||
        !Array.isArray(payload.errors) || payload.errors.length ||
        !Array.isArray(payload.sourceErrors) || payload.sourceErrors.length ||
        typeof budget !== 'number' || !Number.isFinite(budget) || budget <= 0 ||
        startedAtMono + budget <= performance.now()) { cancel(); return; }
    value = { payload: payload, expiresAtMono: startedAtMono + budget };
    if (!claimed) expiry = setTimeout(cancel, Math.max(0, value.expiresAtMono - performance.now()));
    settle(value);
  }).catch(cancel);
})();`;

export function takeStationBootstrap(windowImpl = globalThis.window) {
  const handle = windowImpl?.__ybStationBootstrap;
  if (!handle) return null;
  delete windowImpl.__ybStationBootstrap;
  handle.claim();
  return handle;
}

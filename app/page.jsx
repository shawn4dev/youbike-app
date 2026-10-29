'use client';

import { memo, useState, useEffect, useMemo, useRef, useCallback } from 'react';
import dynamic from 'next/dynamic';
import { AREA_CENTERS, matchArea } from '../lib/areas';
import { guardHistory, sampleIntervalMs, distanceMeters } from '../lib/storage-guard';
import { ensurePermission, maybeNotify } from '../lib/notifications';
import NotificationSettings from '../components/NotificationSettings';
import PWARegister from '../components/PWARegister';
import { createStationLoader } from '../lib/station-data.mjs';
import { requestDeviceLocation } from '../lib/device-location.mjs';

const MapView = dynamic(() => import('../components/MapView'), {
  ssr: false,
  loading: () => <div className="map-loading">地圖載入中…</div>,
});

const HISTORY_MAX = 120;

const CITY_ZOOM = {
  all: { center: [23.9, 121.2], zoom: 8 },
  臺北: { center: [25.04, 121.56], zoom: 12 },
  新北: { center: [25.02, 121.47], zoom: 12 },
  高雄: { center: [22.63, 120.3], zoom: 12 },
};
const BANQIAO_FALLBACK = { lat: 25.0114, lng: 121.4618, zoom: 14 };
const CITIES = ['all', '臺北', '新北', '高雄'];
const STATION_TYPE_OPTIONS = [
  { key: 'empty', label: '無車站', className: 'status-empty' },
  { key: 'full', label: '滿柱站', className: 'status-full' },
  { key: 'normal', label: '可借可還', className: 'status-normal' },
  { key: 'inactive', label: '暫停營運', className: 'status-inactive' },
];

function loadLS(key, fallback) {
  try {
    const v = localStorage.getItem(key);
    return v ? JSON.parse(v) : fallback;
  } catch {
    return fallback;
  }
}
function saveLS(key, val) {
  try {
    localStorage.setItem(key, JSON.stringify(val));
  } catch {}
}

function mergeStations(prevStations, nextStations) {
  const prevMap = new Map(prevStations.map((s) => [s.id, s]));
  const merged = [];
  const seen = new Set();
  let changed = prevStations.length !== nextStations.length;

  for (const next of nextStations) {
    const prev = prevMap.get(next.id);
    if (!prev) {
      changed = true;
      merged.push({ ...next });
      seen.add(next.id);
      continue;
    }

    const same =
      prev.lat === next.lat &&
      prev.lng === next.lng &&
      prev.name === next.name &&
      prev.nameEn === next.nameEn &&
      prev.city === next.city &&
      prev.area === next.area &&
      prev.addr === next.addr &&
      prev.active === next.active &&
      prev.available === next.available &&
      prev.empty === next.empty &&
      prev.total === next.total &&
      prev.regularBikes === next.regularBikes &&
      prev.ebikes === next.ebikes;

    if (!same) changed = true;
    merged.push(same ? prev : { ...prev, ...next });
    seen.add(next.id);
  }

  for (const prev of prevStations) {
    if (!seen.has(prev.id)) {
      changed = true;
      merged.push(prev);
    }
  }

  return changed ? merged : prevStations;
}

function useTheme() {
  const [theme, setTheme] = useState('light');
  useEffect(() => {
    setTheme(document.documentElement.dataset.theme || 'light');
  }, []);
  const toggle = () => {
    const next = theme === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = next;
    saveLS('yb-theme', next);
    setTheme(next);
  };
  return [theme, toggle];
}

function AnimatedNumber({ value }) {
  const [display, setDisplay] = useState(value);
  const [pulse, setPulse] = useState(false);
  useEffect(() => {
    if (value !== display) {
      setPulse(true);
      setDisplay(value);
      const t = setTimeout(() => setPulse(false), 600);
      return () => clearTimeout(t);
    }
  }, [value]);
  return <span className={'num' + (pulse ? ' pulse' : '')}>{display}</span>;
}

function stationViewType(station) {
  if (!station.active) return 'inactive';
  if (station.available === 0) return 'empty';
  if ((station.empty ?? 0) === 0 && station.available > 0) return 'full';
  return 'normal';
}

function syncFavoriteHistory(history, favoriteIds) {
  const source = history && typeof history === 'object' ? history : {};
  const ids = [...new Set((favoriteIds || []).filter((id) => typeof id === 'string' && id))];
  const next = {};
  let changed = Object.keys(source).length !== ids.length;

  for (const id of ids) {
    if (Array.isArray(source[id])) next[id] = source[id];
    else {
      next[id] = [];
      changed = true;
    }
  }

  return changed ? next : source;
}

function stationCapacity(station) {
  const officialTotal = Number(station?.total);
  if (Number.isFinite(officialTotal) && officialTotal > 0) return officialTotal;
  const available = Number(station?.available);
  const empty = Number(station?.empty);
  return Math.max(0, (Number.isFinite(available) ? available : 0) + (Number.isFinite(empty) ? empty : 0));
}

function normalizeHistoryPoints(history, cutoff, capacity) {
  const unique = new Map();
  for (const point of Array.isArray(history) ? history : []) {
    const t = Number(point?.t);
    const a = Number(point?.a);
    const rawEmpty = point?.e;
    const e = rawEmpty == null ? null : Number(rawEmpty);
    if (!Number.isFinite(t) || t < cutoff || !Number.isFinite(a) || a < 0) continue;
    if (e != null && (!Number.isFinite(e) || e < 0)) continue;
    if (capacity > 0 && (a > capacity || (e != null && e > capacity))) continue;
    unique.set(t, { t, a: Math.round(a), e: e == null ? null : Math.round(e) });
  }
  return [...unique.values()].sort((left, right) => left.t - right.t);
}

const StationCard = memo(function StationCard({
  station,
  isSelected,
  isFav,
  low,
  trend,
  minValue,
  maxValue,
  dist,
  onPick,
  onToggleFavorite,
  cardRefs,
}) {
  const denom = station.total > 0 ? station.total : (station.available + (station.empty ?? 0));
  const pct = denom > 0 ? Math.round((station.available / denom) * 100) : 0;

  return (
    <li
      ref={(el) => (cardRefs.current[station.id] = el)}
      className={
        'card' +
        (isSelected ? ' selected glow' : '') +
        (low ? ' low-station' : '')
      }
      onClick={() => onPick(station)}
    >
      <div className="card-top">
        <span className={`city-badge b-${station.city}`}>{station.city}</span>
        <span className="name">{station.name}</span>
        <button
          className={'star' + (isFav ? ' on' : '')}
          onClick={(e) => {
            e.stopPropagation();
            onToggleFavorite(station.id);
          }}
          aria-label="收藏"
        >
          {isFav ? '★' : '☆'}
        </button>
      </div>
      <div className="addr">{station.area} · {station.addr}</div>
      <div className="counts">
          {!station.active ? (
            <span className="inactive-tag">⛔ 暫停營運</span>
          ) : (
            <>
              {station.regularBikes != null && (
                <span className="bike-type" title="一般自行車">🚲 <AnimatedNumber value={station.regularBikes} /></span>
              )}
              {station.ebikes != null && station.ebikes > 0 && (
                <span className="bike-type ebike" title="電輔車">⚡ <AnimatedNumber value={station.ebikes} /></span>
              )}
              {(station.regularBikes == null || station.ebikes == null) && (
                <span className="avail" title="臺北官方 API 未提供車型明細,此為一般+電輔總數">🚲 <AnimatedNumber value={station.available} /></span>
              )}
              <span className="free" title="可停空位">🅿️ <AnimatedNumber value={station.empty ?? 0} /></span>
              {trend && trend !== 'flat' && (
                <span className={'trend ' + trend}>{trend === 'up' ? '↑' : '↓'} 車流中</span>
              )}
            </>
          )}
          {minValue != null && maxValue != null && (
            <span className="minmax" title="近 2 小時最低/最高可借數">
              ↓{minValue} ↑{maxValue}
            </span>
          )}
          {dist != null && dist < 100000 && (
            <span className="dist">{dist >= 1000 ? (dist / 1000).toFixed(1) + 'km' : Math.round(dist) + 'm'}</span>
          )}
          <a
            className="nav-link"
            href={`https://www.google.com/maps/dir/?api=1&destination=${station.lat},${station.lng}`}
            target="_blank"
            rel="noreferrer"
            onClick={(e) => e.stopPropagation()}
          >
            導航 ↗
          </a>
      </div>
      <div className="bar">
        <div className={'fill' + (low ? ' fill-low' : '')} style={{ transform: `scaleX(${Math.min(pct, 100) / 100})` }} />
      </div>
    </li>
  );
});

export default function Home() {
  const [theme, toggleTheme] = useTheme();
  const [stations, setStations] = useState([]);
  const [errors, setErrors] = useState([]);
  const [fetchedAt, setFetchedAt] = useState(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [backgroundLoading, setBackgroundLoading] = useState(false);
  const [searchDraft, setSearchDraft] = useState('');
  const [query, setQuery] = useState('');
  const [city, setCity] = useState('all');
  const [onlyAvailable, setOnlyAvailable] = useState(false);
  const [selectedId, setSelectedId] = useState(null);
  const [chartStationId, setChartStationId] = useState(null);
  const [favorites, setFavorites] = useState([]);
  const [showFavOnly, setShowFavOnly] = useState(false);
  const [userLoc, setUserLoc] = useState(null); // {lat,lng}
  const [geoErr, setGeoErr] = useState(null);
  const [notifSettings, setNotifSettings] = useState({ enabled: false, threshold: 3, activeFrom: 700, activeTo: 2200 });
  const [showImport, setShowImport] = useState(false);
  const [controlsOpen, setControlsOpen] = useState(false);
  const [locating, setLocating] = useState(false);
  const [locationToast, setLocationToast] = useState(null);
  const [listCollapsed, setListCollapsed] = useState(false);
  const [listWidth, setListWidth] = useState(400);
  const [mobileListSize, setMobileListSize] = useState(50);
  const [stationTypeFilters, setStationTypeFilters] = useState({
    empty: true,
    full: true,
    normal: true,
    inactive: true,
  });
  const [boundsFilter, setBoundsFilter] = useState(true); // 只看此地圖範圍
  const [mapBounds, setMapBounds] = useState(null); // {south,west,north,east}
  // 分享網址優先；沒有網址視野時，初始先落在板橋。
  const [mapCenterOverride, setMapCenterOverride] = useState({
    center: [BANQIAO_FALLBACK.lat, BANQIAO_FALLBACK.lng],
    zoom: BANQIAO_FALLBACK.zoom,
  });
  const [recenterToken, setRecenterToken] = useState(0);
  const [popupRequestToken, setPopupRequestToken] = useState(0);
  const [cardScrollRequestToken, setCardScrollRequestToken] = useState(0);
  const [, setHistoryRevision] = useState(0);
  const historyRef = useRef({});
  const listRef = useRef(null);
  const cardRefs = useRef({});
  const notifiedRef = useRef(new Map());
  const mountedRef = useRef(false); // 跳過 mount 當次 URL 寫入,避免撞 Next router 初始化
  const sharedStationIdRef = useRef(null);
  const sharedViewportRef = useRef(null);
  const initialStationSyncPendingRef = useRef(true);
  const didOpenSharedStationRef = useRef(false);
  const controlsRef = useRef(null);
  const searchRef = useRef(null);
  const previousCityRef = useRef(city);
  const mainRef = useRef(null);
  const listWidthRef = useRef(400);
  const mobileListSizeRef = useRef(50);
  const listResizeRef = useRef(null);
  const mobileListResizeRef = useRef(null);
  const stationLoaderRef = useRef(null);
  const cancelLocationRef = useRef(null);
  const autoLocateAllowedRef = useRef(true);

  // 初始載入本地狀態 + URL 分享站號
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const sharedStationId = params.get('station') || null;
    const lat = Number.parseFloat(params.get('lat'));
    const lng = Number.parseFloat(params.get('lng'));
    const zoom = Number.parseInt(params.get('z'), 10);

    sharedStationIdRef.current = sharedStationId;
    setSelectedId(sharedStationId);
    if (Number.isFinite(lat) && Number.isFinite(lng) && Number.isFinite(zoom)) {
      sharedViewportRef.current = { lat, lng, zoom };
      setMapCenterOverride({ center: [lat, lng], zoom });
    } else {
      const saved = loadLS('yb-last-location', null);
      if (Number.isFinite(saved?.lat) && Number.isFinite(saved?.lng)) {
        setUserLoc(saved);
        setMapCenterOverride({ center: [saved.lat, saved.lng], zoom: 15 });
      }
    }

    const savedFavorites = loadLS('yb-favorites', []);
    setFavorites(savedFavorites);
    const savedListWidth = Number(loadLS('yb-list-width', 400));
    if (Number.isFinite(savedListWidth)) {
      const nextWidth = Math.min(640, Math.max(280, savedListWidth));
      listWidthRef.current = nextWidth;
      setListWidth(nextWidth);
    }
    const savedMobileListSize = Number(loadLS('yb-mobile-list-size', 50));
    if (Number.isFinite(savedMobileListSize)) {
      const nextSize = Math.min(75, Math.max(25, savedMobileListSize));
      mobileListSizeRef.current = nextSize;
      setMobileListSize(nextSize);
    }
    const hist = syncFavoriteHistory(
      guardHistory(loadLS('yb-history', {})),
      savedFavorites
    );
    historyRef.current = hist;
    saveLS('yb-history', hist);
    setNotifSettings((prev) => {
      const merged = { ...prev, ...loadLS('yb-notif', {}) };
      return merged;
    });
    mountedRef.current = true; // 標記 mount 完成,之後的 URL 同步才允許寫入
  }, []);

  const applyListWidth = useCallback((width) => {
    const nextWidth = Math.min(640, Math.max(280, Math.round(width)));
    listWidthRef.current = nextWidth;
    mainRef.current?.style.setProperty('--list-width', `${nextWidth}px`);
    return nextWidth;
  }, []);

  function startListResize(event) {
    if (window.matchMedia('(max-width: 900px)').matches || listCollapsed) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    listResizeRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startWidth: listWidthRef.current,
    };
    document.body.classList.add('resizing-list');
  }

  function moveListResize(event) {
    const resize = listResizeRef.current;
    if (!resize || resize.pointerId !== event.pointerId) return;
    applyListWidth(resize.startWidth + event.clientX - resize.startX);
  }

  function finishListResize(event) {
    const resize = listResizeRef.current;
    if (!resize || resize.pointerId !== event.pointerId) return;
    const nextWidth = applyListWidth(resize.startWidth + event.clientX - resize.startX);
    listResizeRef.current = null;
    document.body.classList.remove('resizing-list');
    setListWidth(nextWidth);
    saveLS('yb-list-width', nextWidth);
  }

  function adjustListWidth(delta) {
    const nextWidth = applyListWidth(listWidthRef.current + delta);
    setListWidth(nextWidth);
    saveLS('yb-list-width', nextWidth);
  }

  const applyMobileListSize = useCallback((size) => {
    const nextSize = Math.min(75, Math.max(25, Math.round(size)));
    mobileListSizeRef.current = nextSize;
    mainRef.current?.style.setProperty('--mobile-list-size', `${nextSize}%`);
    return nextSize;
  }, []);

  function startMobileListResize(event) {
    if (!window.matchMedia('(max-width: 900px)').matches || listCollapsed) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    mobileListResizeRef.current = {
      pointerId: event.pointerId,
      startY: event.clientY,
      startSize: mobileListSizeRef.current,
      mainHeight: mainRef.current?.getBoundingClientRect().height || 1,
    };
    document.body.classList.add('resizing-list-mobile');
  }

  function moveMobileListResize(event) {
    const resize = mobileListResizeRef.current;
    if (!resize || resize.pointerId !== event.pointerId) return;
    const deltaPercent = ((event.clientY - resize.startY) / resize.mainHeight) * 100;
    applyMobileListSize(resize.startSize - deltaPercent);
  }

  function finishMobileListResize(event) {
    const resize = mobileListResizeRef.current;
    if (!resize || resize.pointerId !== event.pointerId) return;
    const deltaPercent = ((event.clientY - resize.startY) / resize.mainHeight) * 100;
    const nextSize = applyMobileListSize(resize.startSize - deltaPercent);
    mobileListResizeRef.current = null;
    document.body.classList.remove('resizing-list-mobile');
    setMobileListSize(nextSize);
    saveLS('yb-mobile-list-size', nextSize);
  }

  function adjustMobileListSize(delta) {
    const nextSize = applyMobileListSize(mobileListSizeRef.current + delta);
    setMobileListSize(nextSize);
    saveLS('yb-mobile-list-size', nextSize);
  }

  // 選站後同步 URL
  useEffect(() => {
    if (!mountedRef.current) return; // 跳過 mount 當次,避免撞 Next router 初始化
    if (initialStationSyncPendingRef.current) {
      const sharedStationId = sharedStationIdRef.current;
      if (sharedStationId && selectedId !== sharedStationId) return;
      initialStationSyncPendingRef.current = false;
    }
    try {
      const url = new URL(location.href);
      if (selectedId) url.searchParams.set('station', selectedId);
      else url.searchParams.delete('station');
      history.replaceState(null, '', url);
    } catch {}
  }, [selectedId]);

  const handleMapViewport = useCallback((bounds, zoom) => {
    const centerLat = (bounds.north + bounds.south) / 2;
    const centerLng = (bounds.east + bounds.west) / 2;
    const sharedViewport = sharedViewportRef.current;
    const reachedSharedViewport = !sharedViewport || (
      Math.abs(centerLat - sharedViewport.lat) < 0.002 &&
      Math.abs(centerLng - sharedViewport.lng) < 0.002 &&
      Math.round(zoom) === sharedViewport.zoom
    );

    // Leaflet 會先回報 SSR 時的預設全台視野；分享位置真正套用前不可讓它覆蓋網址。
    if (sharedViewport && reachedSharedViewport) sharedViewportRef.current = null;
    if (mountedRef.current) {
      try {
        if (reachedSharedViewport) {
          const url = new URL(location.href);
          url.searchParams.set('lat', centerLat.toFixed(4));
          url.searchParams.set('lng', centerLng.toFixed(4));
          url.searchParams.set('z', String(Math.round(zoom)));
          history.replaceState(null, '', url);
        }
      } catch {}
    }
    // 只有範圍篩選真的生效時才更新父頁面；一般縮放不觸發整頁 render。
    if (boundsFilter && !query.trim() && !userLoc) {
      setMapBounds((previous) => {
        if (
          previous &&
          previous.south === bounds.south &&
          previous.west === bounds.west &&
          previous.north === bounds.north &&
          previous.east === bounds.east
        ) return previous;
        return bounds;
      });
    }
  }, [boundsFilter, query, userLoc]);

  const receiveStations = useCallback(
    (data) => {
      try {
        setStations((prev) => mergeStations(prev || [], data.stations || []));
        setErrors(data.errors || []);
        setFetchedAt(data.fetchedAt);

        // 取樣(含降頻與容量守衛)
        const now = Date.now();
        const favoriteIds = loadLS('yb-favorites', []);
        const previousHistory = historyRef.current;
        const hist = syncFavoriteHistory(previousHistory, favoriteIds);
        historyRef.current = hist;
        const tracked = favoriteIds.length;
        const minGap = sampleIntervalMs(tracked);
        let changed = hist !== previousHistory;
        for (const s of data.updatedStations || []) {
          if (!hist[s.id]) continue;
          const arr = hist[s.id];
          const lastTime = arr.reduce((latest, point) => {
            const timestamp = Number(point?.t);
            return Number.isFinite(timestamp) ? Math.max(latest, timestamp) : latest;
          }, 0);
          if (!lastTime || now - lastTime > minGap - 1000) {
            arr.push({ t: now, a: s.available, e: s.empty });
            if (arr.length > HISTORY_MAX) arr.shift();
            changed = true;
          }
        }
        if (changed) {
          const pruned = guardHistory(hist);
          const guarded = syncFavoriteHistory(pruned, favoriteIds);
          historyRef.current = guarded;
          // 容量清理可以移除舊樣本，但收藏站的空追蹤槽必須保留。
          for (const id of favoriteIds) {
            if (hist[id]?.length && !pruned[id]) console.warn('[storage-guard] 已清理歷史:', id);
          }
          saveLS('yb-history', guarded);
          setHistoryRevision((revision) => revision + 1);
        }

        // 低車量通知(先確保權限,再檢查)
        if (notifSettings.enabled && 'Notification' in window) {
          if (Notification.permission === 'granted') {
            maybeNotify(data.stations || [], loadLS('yb-favorites', []), notifSettings);
          } else if (Notification.permission === 'default') {
            ensurePermission();
          }
        }
      } catch (e) {
        setErrors(['網路錯誤:' + e.message]);
      } finally {
        setLoading(false);
        setRefreshing(false);
      }
    },
    [notifSettings]
  );

  const receiveStationsRef = useRef(receiveStations);
  receiveStationsRef.current = receiveStations;

  const load = useCallback(async () => {
    setRefreshing(true);
    try { await stationLoaderRef.current?.refresh({ force: true }); }
    finally { setRefreshing(false); }
  }, []);

  useEffect(() => {
    const loader = createStationLoader({ onData: data => receiveStationsRef.current(data), onStatus: setBackgroundLoading });
    stationLoaderRef.current = loader;
    void loader.refresh();
    return () => { loader.stop(); stationLoaderRef.current = null; };
  }, []);

  function focusLocation(lat, lng, { recenter = true } = {}) {
    const location = { lat, lng };
    saveLS('yb-last-location', location);
    setUserLoc(location);
    if (recenter) {
      setMapCenterOverride({ center: [lat, lng], zoom: 15 });
      setRecenterToken((token) => token + 1);
    }
    setGeoErr(null);
    setLocating(false);
  }

  function showLocationToast(message = '已鎖定定位') {
    setLocationToast(message);
    window.setTimeout(() => setLocationToast(null), 2200);
  }

  function requestLocation({ silent = false, savedLocation = null, notify = false } = {}) {
    cancelLocationRef.current?.();
    const cached = savedLocation || loadLS('yb-last-location', null);
    const hasCached = Number.isFinite(cached?.lat) && Number.isFinite(cached?.lng);
    let settled = false;
    let cancelled = false;
    let deviceLocated = false;
    let lastFocusedPoint = null;
    const networkController = new AbortController();
    const apply = (point) => {
      if (cancelled) return;
      const moved = !lastFocusedPoint || Math.abs(point.lat - lastFocusedPoint.lat) > 0.0001 || Math.abs(point.lng - lastFocusedPoint.lng) > 0.0001;
      const recenter = moved && ((!settled && notify) || autoLocateAllowedRef.current);
      focusLocation(point.lat, point.lng, { recenter });
      if (recenter) lastFocusedPoint = point;
      if (notify && !settled) showLocationToast();
      settled = true;
    };
    if (hasCached && notify) focusLocation(cached.lat, cached.lng);
    setLocating(true);
    const cancelDevice = requestDeviceLocation({
      geolocation: navigator.geolocation,
      onPosition: point => {
        deviceLocated = true;
        networkController.abort();
        apply(point);
      },
      onUnavailable: error => {
        setLocating(false);
        if (hasCached) { apply(cached); return; }
        fetch('https://ipapi.co/json/', { signal: AbortSignal.any([networkController.signal, AbortSignal.timeout(2500)]) })
          .then(async (response) => {
            if (!response.ok) throw new Error('network location unavailable');
            const data = await response.json();
            if (!Number.isFinite(data.latitude) || !Number.isFinite(data.longitude)) {
              throw new Error('network location has no coordinates');
            }
            if (!deviceLocated) apply({ lat: data.latitude, lng: data.longitude });
          })
          .catch(() => {
            if (!cancelled && !deviceLocated && !silent) setGeoErr('定位失敗:' + error.message);
          });
      },
    });
    cancelLocationRef.current = () => { cancelled = true; cancelDevice(); networkController.abort(); };
  }

  function locate() {
    autoLocateAllowedRef.current = true;
    setSelectedId(null);
    setChartStationId(null);
    if (userLoc) {
      setMapCenterOverride({ center: [userLoc.lat, userLoc.lng], zoom: 15 });
      setRecenterToken((token) => token + 1);
    }
    requestLocation({ savedLocation: userLoc, notify: true });
  }

  useEffect(() => {
    const params = new URLSearchParams(location.search);
    const urlLat = Number.parseFloat(params.get('lat'));
    const urlLng = Number.parseFloat(params.get('lng'));
    const urlZoom = Number.parseInt(params.get('z'), 10);
    if (Number.isFinite(urlLat) && Number.isFinite(urlLng) && Number.isFinite(urlZoom)) return;

    const saved = loadLS('yb-last-location', null);
    const hasSavedLocation = Number.isFinite(saved?.lat) && Number.isFinite(saved?.lng);
    requestLocation({ silent: true, savedLocation: hasSavedLocation ? saved : null });
    return () => cancelLocationRef.current?.();
  }, []);

  useEffect(() => () => cancelLocationRef.current?.(), []);

  useEffect(() => {
    if (!controlsOpen) return;
    searchRef.current?.focus();
  }, [controlsOpen]);

  useEffect(() => {
    if (!controlsOpen) return;
    const closeOutsideControls = (event) => {
      if (!controlsRef.current?.contains(event.target)) setControlsOpen(false);
    };
    document.addEventListener('pointerdown', closeOutsideControls);
    return () => document.removeEventListener('pointerdown', closeOutsideControls);
  }, [controlsOpen]);

  const trend = useCallback((id) => {
    const arr = historyRef.current[id];
    if (!arr || arr.length < 2) return null;
    const recent = arr.slice(-6);
    const first = recent[0].a;
    const last = recent[recent.length - 1].a;
    if (last === first) return 'flat';
    return last > first ? 'up' : 'down';
  }, []);

  // 近 2 小時最高/最低
  const minmax = useCallback((id) => {
    const arr = historyRef.current[id];
    if (!arr || arr.length < 2) return null;
    const cutoff = Date.now() - 2 * 60 * 60 * 1000;
    const pts = arr.filter((p) => p.t >= cutoff).map((p) => p.a);
    if (pts.length < 2) return null;
    return { min: Math.min(...pts), max: Math.max(...pts) };
  }, []);

  const toggleFavorite = useCallback((id) => {
    setFavorites((prev) => {
      const next = prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id];
      saveLS('yb-favorites', next);
      const hist = historyRef.current;
      if (next.includes(id) && !hist[id]) {
        hist[id] = [];
        const station = stations.find((item) => item.id === id);
        if (station) hist[id].push({ t: Date.now(), a: station.available, e: station.empty });
      }
      if (!next.includes(id)) delete hist[id];
      saveLS('yb-history', hist);
      setHistoryRevision((revision) => revision + 1);
      return next;
    });
  }, [stations]);

  function exportFavs() {
    const data = JSON.stringify({ favorites: loadLS('yb-favorites', []), history: historyRef.current }, null, 2);
    const blob = new Blob([data], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `youbike-favorites-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  function importFavs(e) {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const d = JSON.parse(reader.result);
        let favoriteIds = loadLS('yb-favorites', []);
        if (Array.isArray(d.favorites)) {
          favoriteIds = [...new Set([...favoriteIds, ...d.favorites])];
          saveLS('yb-favorites', favoriteIds);
          setFavorites(favoriteIds);
        }
        const importedHistory = d.history && typeof d.history === 'object' ? d.history : {};
        const synced = syncFavoriteHistory(
          { ...historyRef.current, ...importedHistory },
          favoriteIds
        );
        const now = Date.now();
        for (const id of favoriteIds) {
          if (synced[id].length > 0) continue;
          const station = stations.find((item) => item.id === id);
          if (station) synced[id].push({ t: now, a: station.available, e: station.empty });
        }
        historyRef.current = synced;
        saveLS('yb-history', synced);
        setHistoryRevision((revision) => revision + 1);
        setShowImport(false);
      } catch {
        alert('檔案格式錯誤');
      }
    };
    reader.readAsText(file);
  }

  const favoriteSet = useMemo(() => new Set(favorites), [favorites]);

  const stationDistances = useMemo(() => {
    if (!userLoc) return null;
    return new Map(
      stations.map((s) => [
        s.id,
        !isNaN(s.lat) && !isNaN(s.lng)
          ? distanceMeters(userLoc.lat, userLoc.lng, s.lat, s.lng)
          : Infinity,
      ])
    );
  }, [stations, userLoc]);

  const toggleStationTypeFilter = useCallback((type) => {
    setStationTypeFilters((prev) => ({ ...prev, [type]: !prev[type] }));
  }, []);

  const submitSearch = useCallback((event) => {
    event?.preventDefault();
    const nextQuery = searchDraft.trim();
    setQuery(nextQuery);
    setSelectedId(null);
    setChartStationId(null);
    setMapCenterOverride(null);
  }, [searchDraft]);

  // 搜尋:regex 查詢(支援 |、.*、中文/英文站名),無效 pattern 時退回純文字
  const baseFiltered = useMemo(() => {
    const q = query.trim();
    let matcher = null;
    if (q) {
      try {
        const re = new RegExp(q, 'i');
        matcher = (s) =>
          re.test(s.name) || re.test(s.nameEn) || re.test(s.area) || re.test(s.addr);
      } catch {
        // 無效 regex(如未閉合括號)→ 當普通字串
        const lq = q.toLowerCase();
        matcher = (s) =>
          s.name.toLowerCase().includes(lq) ||
          s.area.includes(q) ||
          s.addr.toLowerCase().includes(lq) ||
          s.nameEn.toLowerCase().includes(lq);
      }
    }
    let list = stations
      .filter((s) => city === 'all' || s.city === city)
      .filter((s) => !onlyAvailable || s.available > 0)
      .filter((s) => !showFavOnly || favoriteSet.has(s.id))
      .filter((s) => !matcher || matcher(s));
    // 地圖範圍過濾:有搜尋字時停用;定位模式也停用(距離排序已含範圍語意)
    if (boundsFilter && !q && !userLoc && mapBounds) {
      list = list.filter(
        (s) =>
          !isNaN(s.lat) &&
          !isNaN(s.lng) &&
          s.lat >= mapBounds.south &&
          s.lat <= mapBounds.north &&
          s.lng >= mapBounds.west &&
          s.lng <= mapBounds.east
      );
    }
    // 有定位時仍依距離排序，但不再限制只能顯示 10 公里內的站點。
    if (stationDistances) {
      list = list
        .sort((a, b) => {
          const fa = favoriteSet.has(a.id) ? 1 : 0;
          const fb = favoriteSet.has(b.id) ? 1 : 0;
          if (fa !== fb) return fb - fa;
          return (stationDistances.get(a.id) ?? Infinity) - (stationDistances.get(b.id) ?? Infinity);
        });
    } else {
      list.sort((a, b) => {
        const fa = favoriteSet.has(a.id) ? 1 : 0;
        const fb = favoriteSet.has(b.id) ? 1 : 0;
        if (fa !== fb) return fb - fa;
        return b.available - a.available;
      });
    }
    return list;
  }, [stations, query, city, onlyAvailable, showFavOnly, favoriteSet, stationDistances, boundsFilter, mapBounds]);

  const stationTypeCounts = useMemo(
    () =>
      baseFiltered.reduce(
        (acc, station) => {
          acc[stationViewType(station)] += 1;
          return acc;
        },
        { empty: 0, full: 0, normal: 0, inactive: 0 }
      ),
    [baseFiltered]
  );

  const activeStationTypeCount = useMemo(
    () => Object.values(stationTypeFilters).filter(Boolean).length,
    [stationTypeFilters]
  );
  const activeExtraFilterCount = useMemo(
    () => [showFavOnly, boundsFilter, onlyAvailable].filter(Boolean).length,
    [showFavOnly, boundsFilter, onlyAvailable]
  );
  const primaryExtraFilterLabel = useMemo(() => {
    if (showFavOnly) return '收藏';
    if (boundsFilter) return '範圍';
    if (onlyAvailable) return '有車';
    return '預設';
  }, [showFavOnly, boundsFilter, onlyAvailable]);

  const filtered = useMemo(
    () =>
      baseFiltered.filter((station) => {
        const type = stationViewType(station);
        return stationTypeFilters[type];
      }),
    [baseFiltered, stationTypeFilters]
  );

  // 初始 bounds 尚未由 Leaflet 回報時，避免先建立全臺 marker 再立刻大量移除。
  const mapStations = useMemo(
    () =>
      boundsFilter && !query.trim() && !userLoc && !mapBounds
        ? []
        : filtered,
    [boundsFilter, query, userLoc, mapBounds, filtered]
  );

  // 範圍內統計(給 header 統計列與徽章)
  const rangeStats = useMemo(() => {
    if (!boundsFilter || !mapBounds || query.trim() || userLoc) return null;
    const inRange = stations.filter(
      (s) =>
        !isNaN(s.lat) &&
        !isNaN(s.lng) &&
        s.lat >= mapBounds.south &&
        s.lat <= mapBounds.north &&
        s.lng >= mapBounds.west &&
        s.lng <= mapBounds.east
    );
    return {
      count: inRange.length,
      bikes: inRange.reduce((sum, s) => sum + (s.active ? s.available : 0), 0),
      emptyStations: inRange.filter((s) => s.active && s.available === 0).length,
    };
  }, [stations, mapBounds, boundsFilter, query, userLoc]);

  // 最終顯示清單：縮放地圖不再改動卡片順序，避免列表抖動。
  const displayList = useMemo(() => {
    let list = filtered.slice(0, 300);
    if (selectedId && !list.some((s) => s.id === selectedId)) {
      const sel = stations.find((x) => x.id === selectedId);
      if (sel) list = [sel, ...list.slice(0, Math.max(list.length - 1, 299))];
    }
    return list;
  }, [filtered, selectedId, stations]);

  // 搜尋區名 → 地圖飛到區域中心
  const areaTarget = useMemo(() => {
    const area = matchArea(query);
    if (!area) return null;
    const pts = stations.filter((s) => s.area === area && !isNaN(s.lat));
    if (pts.length === 0) return null;
    return {
      name: area,
      center: AREA_CENTERS[area] ?? [
        pts.reduce((sum, s) => sum + s.lat, 0) / pts.length,
        pts.reduce((sum, s) => sum + s.lng, 0) / pts.length,
      ],
      count: pts.length,
    };
  }, [query, stations]);

  // 一般關鍵字搜尋要聚焦實際結果，不能在清除前次行政區後退回全臺視野。
  const searchTarget = useMemo(() => {
    if (!query.trim() || areaTarget) return null;
    const points = baseFiltered.filter(
      (station) => Number.isFinite(station.lat) && Number.isFinite(station.lng)
    );
    if (points.length === 0) return null;

    const lats = points.map((station) => station.lat);
    const lngs = points.map((station) => station.lng);
    const south = Math.min(...lats);
    const north = Math.max(...lats);
    const west = Math.min(...lngs);
    const east = Math.max(...lngs);
    const span = Math.max(north - south, east - west);
    const zoom =
      points.length === 1 || span < 0.012 ? 15
        : span < 0.035 ? 14
          : span < 0.09 ? 13
            : span < 0.22 ? 12
              : span < 0.5 ? 10
                : 8;

    return {
      center: [(south + north) / 2, (west + east) / 2],
      zoom,
    };
  }, [query, areaTarget, baseFiltered]);

  // 搜尋/切區域有 areaTarget 時,清除手動設定的 mapCenterOverride(讓 areaTarget 生效飛圖)
  useEffect(() => {
    if (areaTarget) setMapCenterOverride(null);
  }, [areaTarget]);

  // 切城市時清除過濾狀態 + override
  useEffect(() => {
    if (previousCityRef.current === city) return;
    previousCityRef.current = city;
    setMapCenterOverride(null);
    setSearchDraft('');
    setQuery('');
    setOnlyAvailable(false);
    setShowFavOnly(false);
    setSelectedId(null);
    setChartStationId(null);
  }, [city]);

  const pick = useCallback((s, { recenter = true } = {}) => {
    autoLocateAllowedRef.current = false;
    // 每次點擊都建立新的列表定位請求；重複點同一站時 selectedId 不會改變。
    setCardScrollRequestToken((token) => token + 1);
    setSelectedId((prev) => {
      if (prev === s.id) return prev;
      return s.id;
    });
    if (city !== 'all' && s.city !== city) setCity('all');
    setControlsOpen(false);
    if (recenter) {
      setMapCenterOverride((prev) => {
        if (
          prev &&
          prev.center[0] === s.lat &&
          prev.center[1] === s.lng &&
          prev.zoom === 15
        ) {
          return prev;
        }
        return { center: [s.lat, s.lng], zoom: 15 };
      });
      // 即使再次點擊同一張卡片，也重新定位並在移動完成後開啟站點詳情。
      setRecenterToken((token) => token + 1);
      setPopupRequestToken((token) => token + 1);
    }
  }, [city]);

  // 篩選/查詢變更時取消選取，避免卡片卡在 pending
  const prevFilterRef = useRef(null);
  useEffect(() => {
    const current = JSON.stringify({
      query,
      onlyAvailable,
      showFavOnly,
      stationTypeFilters,
      boundsFilter,
    });
    if (prevFilterRef.current !== null && prevFilterRef.current !== current) {
      setSelectedId(null);
      setChartStationId(null);
    }
    prevFilterRef.current = current;
  }, [query, onlyAvailable, showFavOnly, stationTypeFilters, boundsFilter]);

  // popup/地圖點擊 → 捲動列表到該卡片並高亮
  useEffect(() => {
    // 列表收合時卡片不可見；此時捲動卡片會連帶捲動 .main，露出底部空白。
    // 直接略過也能保留使用者收合前的列表捲動位置。
    if (listCollapsed || !selectedId || !listRef.current) return;
    const el = cardRefs.current[selectedId];
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  }, [selectedId, cardScrollRequestToken]);

  const selected =
    stations.find((s) => s.id === selectedId) ||
    filtered.find((s) => s.id === selectedId) || null;

  // 分享網址載入時，等資料與 marker 就緒後只自動開啟一次詳細氣泡。
  useEffect(() => {
    if (
      didOpenSharedStationRef.current ||
      !sharedStationIdRef.current ||
      selected?.id !== sharedStationIdRef.current
    ) return;
    didOpenSharedStationRef.current = true;
    setPopupRequestToken((token) => token + 1);
  }, [selected?.id]);

  const mapCenter =
    mapCenterOverride
      ? mapCenterOverride
      : areaTarget
        ? { center: areaTarget.center, zoom: 13 }
        : searchTarget || CITY_ZOOM[city];

  const fmtTime = (t) =>
    t ? new Date(t).toLocaleTimeString('zh-TW', { hour12: false }) : '—';

  const favCount = favorites.length;

  // 鍵盤導航
  const focusIndex = useRef(-1);
  useEffect(() => {
    function onKey(e) {
      if (e.key === '/' && document.activeElement?.tagName !== 'INPUT') {
        e.preventDefault();
        document.querySelector('.search')?.focus();
      } else if (e.key === 'Escape') {
        setSearchDraft('');
        setQuery('');
        setChartStationId(null);
        document.activeElement?.blur();
      } else if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && filtered.length) {
        e.preventDefault();
        focusIndex.current =
          e.key === 'ArrowDown'
            ? Math.min(focusIndex.current + 1, filtered.length - 1)
            : Math.max(focusIndex.current - 1, 0);
        const target = filtered[focusIndex.current];
        if (target) pick(target);
      } else if (e.key === 'Enter' && selectedId) {
        setChartStationId((v) => (v === selectedId ? null : selectedId));
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [filtered, selectedId]);

  return (
    <div className="app">
      <PWARegister />
      <header className="header glass">
        <div className="header-row">
          <h1>
            🚲 YouBike <span className="grad">站點查詢</span>
          </h1>
          <div className="header-actions">
            <button className="icon-btn" onClick={locate} title="定位到目前位置" aria-label="定位" disabled={locating}>
              {locating ? '…' : '📍'}
            </button>
            <NotificationSettings settings={notifSettings} onChange={(s) => { saveLS('yb-notif', s); setNotifSettings(s); }} />
            <button className="icon-btn" onClick={() => setShowImport((v) => !v)} title="匯出/匯入" aria-label="備份">⇅</button>
            <button className="icon-btn" onClick={toggleTheme} aria-label="切換主題">
              {theme === 'dark' ? '☀️' : '🌙'}
            </button>
          </div>
        </div>
        {showImport && (
          <div className="io-row">
            <button className="chip" onClick={exportFavs}>⬇ 匯出收藏/追蹤</button>
            <label className="chip file-chip">
              ⬆ 匯入 JSON
              <input type="file" accept=".json" onChange={importFavs} hidden />
            </label>
          </div>
        )}
        <div className="status">
          {loading ? (
            '載入中…'
          ) : (
            <>
              {filtered.length} 站
              {rangeStats && ` · 範圍內可借 ${rangeStats.bikes} 輛`}
              {rangeStats && rangeStats.emptyStations > 0 && ` · ${rangeStats.emptyStations} 站無車`}
              {` · 更新於 ${fmtTime(fetchedAt)}`}
              {refreshing ? ' · 刷新中…' : ''}
              {backgroundLoading ? ' · 資料更新中…' : ''}
              {userLoc ? ' · 📍依距離排序' : ''}
              {' · '}
              <button className="refresh-btn" onClick={() => load(true)} disabled={refreshing}>
                ↻ 手動刷新
              </button>
            </>
          )}
          {geoErr && <span className="geo-err"> · {geoErr}</span>}
        </div>
        {errors.length > 0 && (
          <div className="error-banner">⚠️ 部分資料源失敗:{errors.join('、')}</div>
        )}
      </header>
      {locationToast && <div className="location-toast" role="status">📍 {locationToast}</div>}

      <div
        className="controls"
        ref={controlsRef}
        onBlurCapture={(event) => {
          if (event.relatedTarget && !event.currentTarget.contains(event.relatedTarget)) setControlsOpen(false);
        }}
      >
        <button
          className="controls-trigger"
          type="button"
          aria-expanded={controlsOpen}
          onClick={() => setControlsOpen((open) => !open)}
        >
          <span>⌕ 搜尋與篩選</span>
          <span className="controls-trigger-meta">{filtered.length} 站 · 站態 {activeStationTypeCount}/4</span>
        </button>
        {controlsOpen && (
          <div className="controls-popover">
            <div className="controls-popover-header">
              <span>搜尋與篩選</span>
              <button
                type="button"
                className="controls-close"
                aria-label="關閉搜尋與篩選"
                title="關閉"
                onClick={() => setControlsOpen(false)}
              >
                ✕
              </button>
            </div>
            <form className="controls-top-row" role="search" onSubmit={submitSearch}>
              <input
                ref={searchRef}
                className="search"
                type="search"
                enterKeyHint="search"
                aria-label="搜尋站名、行政區或地址"
                placeholder="搜尋站名 / 區域 / 地址"
                value={searchDraft}
                onChange={(e) => setSearchDraft(e.target.value)}
              />
              <button className="search-submit" type="submit" aria-label="搜尋" title="搜尋">
                <svg viewBox="0 0 24 24" aria-hidden="true">
                  <circle cx="11" cy="11" r="6.5" />
                  <path d="m16 16 4 4" />
                </svg>
              </button>
            </form>
            {areaTarget && (
              <div className="area-hint">🗺️ 偵測到「{areaTarget.name}」{areaTarget.count} 站 — 地圖已定位</div>
            )}
            <div className="filter-group city-filters-panel">
              <div className="status-filters-head">
                <span className="status-filters-title">城市</span>
                <span className="status-filters-subtitle">選擇資料範圍</span>
              </div>
              <div className="chips city-chips">
                {CITIES.map((c) => (
                  <button
                    type="button"
                    key={c}
                    className={'chip' + (city === c ? ' active' : '')}
                    onClick={() => {
                      setCity(c);
                      // 城市模式不應被目前定位的距離篩選限制。
                      setControlsOpen(false);
                      setSelectedId((id) => {
                        if (!id) return id;
                        const prefix = { 臺北: 'tp-', 新北: 'ntpc-', 高雄: 'kcg-' }[c];
                        if (prefix && !id.startsWith(prefix)) return null;
                        return id;
                      });
                      setChartStationId(null);
                    }}
                  >
                    {c === 'all' ? '全部' : c}
                  </button>
                ))}
              </div>
            </div>
            <div className="filter-group status-filters-panel">
                <div className="status-filters-head">
                  <span className="status-filters-title">站態</span>
                  <span className="status-filters-subtitle">可同時勾選多種狀態</span>
                </div>
                <div className="status-filters">
                  {STATION_TYPE_OPTIONS.map((option) => (
                    <label key={option.key} className={`status-toggle ${option.className}`}>
                      <input
                        type="checkbox"
                        checked={stationTypeFilters[option.key]}
                        onChange={() => toggleStationTypeFilter(option.key)}
                      />
                      <span className="status-toggle-label">{option.label}</span>
                      <span className="status-toggle-count">{stationTypeCounts[option.key]}</span>
                    </label>
                  ))}
                </div>
            </div>
            <div className="filter-group extra-filters-panel">
                <div className="status-filters-head">
                  <span className="status-filters-title">其他</span>
                  <span className="status-filters-subtitle">依偏好與目前地圖範圍篩選</span>
                </div>
                <div className="chips advanced-chips">
                  <button className={'chip' + (showFavOnly ? ' active-fav' : '')} onClick={() => setShowFavOnly((v) => !v)}>
                    ⭐ 收藏{favCount ? ` ${favCount}` : ''}
                  </button>
                  <label className="toggle">
                    <input
                      type="checkbox"
                      checked={boundsFilter}
                      onChange={(e) => setBoundsFilter(e.target.checked)}
                    />
                    只看此地圖範圍
                  </label>
                  <label className="toggle">
                    <input type="checkbox" checked={onlyAvailable} onChange={(e) => setOnlyAvailable(e.target.checked)} />
                    只看有車
                  </label>
                </div>
            </div>
          </div>
        )}
      </div>

      <div
        ref={mainRef}
        className={'main' + (listCollapsed ? ' list-collapsed' : '')}
        style={{
          '--list-width': `${listWidth}px`,
          '--mobile-list-size': `${mobileListSize}%`,
        }}
      >
        <aside className="station-panel" aria-label="站點卡片列表">
          <button
            type="button"
            className="list-collapse-btn"
            aria-expanded={!listCollapsed}
            aria-controls="station-list"
            title={listCollapsed ? '展開站點列表' : '收合站點列表'}
            onClick={() => setListCollapsed((collapsed) => !collapsed)}
          >
            <span className="collapse-icon-desktop" aria-hidden="true">{listCollapsed ? '›' : '‹'}</span>
            <span className="collapse-icon-mobile" aria-hidden="true">{listCollapsed ? '⌃' : '⌄'}</span>
            <span className="sr-only">{listCollapsed ? '展開站點列表' : '收合站點列表'}</span>
          </button>
          <div
            className="list-resize-handle"
            role="separator"
            aria-label="調整站點列表寬度"
            aria-orientation="vertical"
            aria-valuemin="280"
            aria-valuemax="640"
            aria-valuenow={listWidth}
            tabIndex={listCollapsed ? -1 : 0}
            onPointerDown={startListResize}
            onPointerMove={moveListResize}
            onPointerUp={finishListResize}
            onPointerCancel={finishListResize}
            onKeyDown={(event) => {
              if (event.key === 'ArrowLeft') {
                event.preventDefault();
                adjustListWidth(-20);
              } else if (event.key === 'ArrowRight') {
                event.preventDefault();
                adjustListWidth(20);
              }
            }}
          />
          <div
            className="list-resize-handle-mobile"
            role="separator"
            aria-label="調整站點列表高度"
            aria-orientation="horizontal"
            aria-valuemin="25"
            aria-valuemax="75"
            aria-valuenow={mobileListSize}
            tabIndex={listCollapsed ? -1 : 0}
            onPointerDown={startMobileListResize}
            onPointerMove={moveMobileListResize}
            onPointerUp={finishMobileListResize}
            onPointerCancel={finishMobileListResize}
            onKeyDown={(event) => {
              if (event.key === 'ArrowUp') {
                event.preventDefault();
                adjustMobileListSize(5);
              } else if (event.key === 'ArrowDown') {
                event.preventDefault();
                adjustMobileListSize(-5);
              }
            }}
          />
          <ul id="station-list" className="list" ref={listRef}>
          {loading &&
            Array.from({ length: 8 }).map((_, i) => (
              <li key={i} className="card skeleton">
                <div className="sk-line w60" />
                <div className="sk-line w80" />
                <div className="sk-line w40" />
              </li>
            ))}
          {!loading &&
            displayList.map((s) => {
              const mm = minmax(s.id);
              return (
                <StationCard
                  key={s.id}
                  station={s}
                  isSelected={s.id === selectedId}
                  isFav={favoriteSet.has(s.id)}
                  low={s.active && (s.available === 0 || s.empty === 0)}
                  trend={trend(s.id)}
                  minValue={mm?.min ?? null}
                  maxValue={mm?.max ?? null}
                  dist={stationDistances?.get(s.id) ?? null}
                  onPick={pick}
                  onToggleFavorite={toggleFavorite}
                  cardRefs={cardRefs}
                />
              );
            })}
          {!loading && filtered.length === 0 && <li className="no-result">沒有符合的站點</li>}
          {filtered.length > 300 && <li className="no-result">僅顯示前 300 筆,請縮小搜尋範圍</li>}
          </ul>
        </aside>

        <MapView
          stations={mapStations}
          center={mapCenter.center}
          zoom={mapCenter.zoom}
          onSelect={pick}
          selected={selected}
          theme={theme}
          userLoc={userLoc}
          onBoundsChange={handleMapViewport}
          recenterToken={recenterToken}
          popupRequestToken={popupRequestToken}
          markerSetKey={query}
          areaTarget={areaTarget}
          onInteraction={() => { autoLocateAllowedRef.current = false; }}
        />
      </div>

      {chartStationId && selected && chartStationId === selected.id && (
        <HistoryChart
          station={selected}
          history={historyRef.current[selected.id] || []}
          onClose={() => setChartStationId(null)}
        />
      )}
      {selected && chartStationId !== selected.id && (
        <button className="chart-btn" onClick={() => setChartStationId(selected.id)}>
          📈 查看「{selected.name.slice(0, 8)}…」車輛趨勢
        </button>
      )}
    </div>
  );
}

function HistoryChart({ station, history, onClose }) {
  const [window_, setWindow_] = useState(120); // 分鐘
  const [hover, setHover] = useState(null);

  const cutoff = Date.now() - window_ * 60 * 1000;
  const baseCapacity = stationCapacity(station);
  const pts = normalizeHistoryPoints(history, cutoff, baseCapacity);
  const w = 560, h = 170, pad = 30;

  const sampleMax = Math.max(0, ...pts.flatMap((p) => [p.a, p.e ?? 0]));
  const capacity = Math.max(baseCapacity, sampleMax, 1);
  const yMax = Math.max(1, Math.ceil(capacity * 1.1));
  const x = (i) => pad + (i / Math.max(pts.length - 1, 1)) * (w - pad * 2);
  const y = (v) => h - pad - (v / yMax) * (h - pad * 2);

  const line = (key) =>
    pts.map((p, i) => `${i === 0 ? 'M' : 'L'}${x(i)},${y(p[key] ?? 0)}`).join(' ');

  return (
    <div className="chart-drawer glass">
      <div className="chart-head">
        <b>📈 {station.name}</b>
        <span className="muted">{pts.length} 筆取樣</span>
        <div className="win-switch">
          {[30, 60, 120].map((m) => (
            <button key={m} className={'win-btn' + (window_ === m ? ' on' : '')} onClick={() => setWindow_(m)}>
              {m <= 60 ? `${m}分` : '2時'}
            </button>
          ))}
        </div>
        <button className="icon-btn" onClick={onClose}>✕</button>
      </div>
      {pts.length >= 2 ? (
        <>
          <svg viewBox={`0 0 ${w} ${h}`} className="chart-svg"
            onMouseMove={(e) => {
              const rect = e.currentTarget.getBoundingClientRect();
              const px = ((e.clientX - rect.left) / rect.width) * w;
              let best = null, bd = Infinity;
              pts.forEach((p, i) => {
                const d = Math.abs(x(i) - px);
                if (d < bd) { bd = d; best = i; }
              });
              if (best != null) setHover({ ...pts[best], x: x(best) });
            }}
            onMouseLeave={() => setHover(null)}
          >
            <path d={`${line('a')} L${x(pts.length - 1)},${h - pad} L${pad},${h - pad} Z`} className="chart-area" />
            <path d={line('a')} className="chart-line" />
            {pts.some((p) => p.e != null) && <path d={line('e')} className="chart-line-2" />}
            {hover && (
              <g>
                <line x1={hover.x} y1={pad} x2={hover.x} y2={h - pad} className="chart-crosshair" />
                <circle cx={hover.x} cy={y(hover.a)} r={4} className="chart-dot" />
              </g>
            )}
            <text x={4} y={y(yMax) + 10} className="chart-label">{yMax}</text>
            <text x={4} y={h - pad + 4} className="chart-label">0</text>
          </svg>
          <div className="chart-legend">
            <span><i className="li-a" />可借</span>
            {pts.some((p) => p.e != null) && <span><i className="li-e" />可還</span>}
            <span className="chart-hover-info">
              {hover
                ? `${new Date(hover.t).toLocaleTimeString('zh-TW', { hour12: false })} · 可借 ${hover.a}${hover.e != null ? ` · 可還 ${hover.e}` : ''}`
                : '滑過曲線查看數值'}
            </span>
          </div>
        </>
      ) : (
        <p className="muted">追蹤中 — 資料累積中(每分鐘取樣一次),稍後再回來看曲線。</p>
      )}
    </div>
  );
}

'use client';

import { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import dynamic from 'next/dynamic';
import { AREA_CENTERS, matchArea } from '../lib/areas';
import { guardHistory, sampleIntervalMs, distanceMeters } from '../lib/storage-guard';
import { ensurePermission, maybeNotify } from '../lib/notifications';
import NotificationSettings from '../components/NotificationSettings';
import PWARegister from '../components/PWARegister';

const MapView = dynamic(() => import('../components/MapView'), {
  ssr: false,
  loading: () => <div className="map-loading">地圖載入中…</div>,
});

const REFRESH_MS = 60 * 1000;
const HISTORY_MAX = 120;

const CITY_ZOOM = {
  all: { center: [23.9, 121.2], zoom: 8 },
  臺北: { center: [25.04, 121.56], zoom: 12 },
  新北: { center: [25.02, 121.47], zoom: 12 },
  高雄: { center: [22.63, 120.3], zoom: 12 },
};
const CITIES = ['all', '臺北', '新北', '高雄'];

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

export default function Home() {
  const [theme, toggleTheme] = useTheme();
  const [stations, setStations] = useState([]);
  const [errors, setErrors] = useState([]);
  const [fetchedAt, setFetchedAt] = useState(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
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
  const [boundsFilter, setBoundsFilter] = useState(true); // 只看此地圖範圍
  const [mapBounds, setMapBounds] = useState(null); // {south,west,north,east}
  const [mapZoom, setMapZoom] = useState(null);
  const [clusteredIds, setClusteredIds] = useState(new Set()); // 目前被聚合的站
  const [lowOnly, setLowOnly] = useState(false); // 徽章點擊:只看無車站
  const [mapCenterOverride, setMapCenterOverride] = useState(null); // 📍 二次點擊回定位
  const historyRef = useRef({});
  const listRef = useRef(null);
  const cardRefs = useRef({});
  const notifiedRef = useRef(new Map());
  const mountedRef = useRef(false); // 跳過 mount 當次 URL 寫入,避免撞 Next router 初始化

  // 初始載入本地狀態 + URL 分享站號
  useEffect(() => {
    setFavorites(loadLS('yb-favorites', []));
    const hist = guardHistory(loadLS('yb-history', {}));
    historyRef.current = hist;
    saveLS('yb-history', hist);
    setNotifSettings((prev) => {
      const merged = { ...prev, ...loadLS('yb-notif', {}) };
      return merged;
    });
    const urlId = new URLSearchParams(location.search).get('station');
    if (urlId) setSelectedId(urlId);
    // 分享連結:還原地圖視野
    const lat = parseFloat(new URLSearchParams(location.search).get('lat'));
    const lng = parseFloat(new URLSearchParams(location.search).get('lng'));
    const z = parseInt(new URLSearchParams(location.search).get('z'));
    if (!isNaN(lat) && !isNaN(lng) && !isNaN(z)) {
      setMapCenterOverride({ center: [lat, lng], zoom: z });
    }
    mountedRef.current = true; // 標記 mount 完成,之後的 URL 同步才允許寫入
  }, []);

  // 選站後同步 URL
  useEffect(() => {
    if (!mountedRef.current) return; // 跳過 mount 當次,避免撞 Next router 初始化
    try {
      const url = new URL(location.href);
      if (selectedId) url.searchParams.set('station', selectedId);
      else url.searchParams.delete('station');
      history.replaceState(null, '', url);
    } catch {}
  }, [selectedId]);

  // 地圖視野同步 URL(分享連結)— 停止移動後寫入
  useEffect(() => {
    if (!mountedRef.current) return; // 跳過 mount 當次
    if (!mapBounds || mapZoom == null) return;
    try {
      const url = new URL(location.href);
      url.searchParams.set('lat', ((mapBounds.north + mapBounds.south) / 2).toFixed(4));
      url.searchParams.set('lng', ((mapBounds.east + mapBounds.west) / 2).toFixed(4));
      url.searchParams.set('z', String(Math.round(mapZoom)));
      history.replaceState(null, '', url);
    } catch {}
  }, [mapBounds, mapZoom]);

  const load = useCallback(
    async (force = false) => {
      if (force) setRefreshing(true);
      try {
        const res = await fetch('/api/stations' + (force ? '?force=1' : ''));
        const data = await res.json();
        setStations(data.stations || []);
        setErrors(data.errors || []);
        setFetchedAt(data.fetchedAt);

        // 取樣(含降頻與容量守衛)
        const now = Date.now();
        const hist = historyRef.current;
        const tracked = Object.keys(hist).length;
        const minGap = sampleIntervalMs(tracked);
        let changed = false;
        for (const s of data.stations || []) {
          if (!hist[s.id]) continue;
          const arr = hist[s.id];
          const last = arr[arr.length - 1];
          if (!last || now - last.t > minGap - 1000) {
            arr.push({ t: now, a: s.available, e: s.empty });
            if (arr.length > HISTORY_MAX) arr.shift();
            changed = true;
          }
        }
        if (changed) {
          const guarded = guardHistory(hist);
          historyRef.current = guarded;
          // 清理後若某站被移除,從追蹤清單也移除
          for (const id of Object.keys(hist)) {
            if (!guarded[id]) console.warn('[storage-guard] 已清理歷史:', id);
          }
          saveLS('yb-history', guarded);
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

  useEffect(() => {
    load();
    const timer = setInterval(() => load(false), REFRESH_MS);
    return () => clearInterval(timer);
  }, [load]);

  function locate() {
    if (!navigator.geolocation) {
      setGeoErr('此瀏覽器不支援定位');
      return;
    }
    // 二次點擊 = 已有定位 → 直接把地圖帶回自己位置
    if (userLoc) {
      setMapCenterOverride({ center: [userLoc.lat, userLoc.lng], zoom: 15 });
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setUserLoc({ lat: pos.coords.latitude, lng: pos.coords.longitude });
        setMapCenterOverride({ center: [pos.coords.latitude, pos.coords.longitude], zoom: 15 });
        setGeoErr(null);
      },
      (err) => setGeoErr('定位失敗:' + err.message),
      { enableHighAccuracy: true, timeout: 10000 }
    );
  }

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

  function toggleFavorite(id) {
    setFavorites((prev) => {
      const next = prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id];
      saveLS('yb-favorites', next);
      const hist = historyRef.current;
      if (next.includes(id) && !hist[id]) hist[id] = [];
      if (!next.includes(id)) delete hist[id];
      saveLS('yb-history', hist);
      return next;
    });
  }

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
        if (Array.isArray(d.favorites)) {
          const merged = [...new Set([...loadLS('yb-favorites', []), ...d.favorites])];
          saveLS('yb-favorites', merged);
          setFavorites(merged);
        }
        if (d.history && typeof d.history === 'object') {
          const merged = { ...historyRef.current, ...d.history };
          historyRef.current = merged;
          saveLS('yb-history', merged);
        }
        setShowImport(false);
      } catch {
        alert('檔案格式錯誤');
      }
    };
    reader.readAsText(file);
  }

  // 搜尋:regex 查詢(支援 |、.*、中文/英文站名),無效 pattern 時退回純文字
  const filtered = useMemo(() => {
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
      .filter((s) => !showFavOnly || favorites.includes(s.id))
      .filter((s) => !lowOnly || s.available === 0)
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
    // 定位模式:按距離排序,超過 10km 的站排到最後
    if (userLoc) {
      list = list
        .map((s) => ({
          ...s,
          dist:
            !isNaN(s.lat) && !isNaN(s.lng)
              ? distanceMeters(userLoc.lat, userLoc.lng, s.lat, s.lng)
              : Infinity,
        }))
        .sort((a, b) => {
          const fa = favorites.includes(a.id) ? 1 : 0;
          const fb = favorites.includes(b.id) ? 1 : 0;
          if (fa !== fb) return fb - fa;
          return a.dist - b.dist;
        });
      list = list.filter((s) => s.dist <= 10000);
    } else {
      list.sort((a, b) => {
        const fa = favorites.includes(a.id) ? 1 : 0;
        const fb = favorites.includes(b.id) ? 1 : 0;
        if (fa !== fb) return fb - fa;
        return b.available - a.available;
      });
    }
    return list;
  }, [stations, query, city, onlyAvailable, showFavOnly, favorites, userLoc, boundsFilter, mapBounds, lowOnly]);

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

  // 最終顯示清單:
  // 1. 選中站保證在內(插入最上)
  // 2. >300 筆時排除「目前被聚合」的站(選中站例外);排除後 ≤300 就全列
  const displayList = useMemo(() => {
    let list = filtered;
    if (list.length > 300 && clusteredIds.size > 0) {
      list = list.filter((s) => !clusteredIds.has(s.id) || s.id === selectedId);
      if (list.length > 300) list = list.slice(0, 300);
    } else if (list.length > 300) {
      // 沒有聚合資訊時,選中站保底插隊
      list = list.slice(0, 300);
    }
    if (selectedId && !list.some((s) => s.id === selectedId)) {
      const sel = stations.find((x) => x.id === selectedId);
      if (sel) list = [sel, ...list.slice(0, Math.max(list.length - 1, 299))];
    }
    return list;
  }, [filtered, clusteredIds, selectedId, stations]);

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

  // 搜尋/切區域有 areaTarget 時,清除手動設定的 mapCenterOverride(讓 areaTarget 生效飛圖)
  useEffect(() => {
    if (areaTarget) setMapCenterOverride(null);
  }, [areaTarget]);

  // 切城市時清除過濾狀態 + override
  useEffect(() => {
    setMapCenterOverride(null);
    setQuery('');
    setOnlyAvailable(false);
    setShowFavOnly(false);
    setLowOnly(false);
    setSelectedId(null);
    setChartStationId(null);
  }, [city]);

  function pick(s) {
    setSelectedId(s.id);
    // 清除所有過濾狀態，確保站點能顯示
    setQuery('');
    setOnlyAvailable(false);
    setShowFavOnly(false);
    setLowOnly(false);
    if (city !== 'all' && s.city !== city) setCity('all');
    // 直接設定強制中心,讓 Recenter 立即飛圖
    setMapCenterOverride({ center: [s.lat, s.lng], zoom: 15 });
  }

  // popup/地圖點擊 → 捲動列表到該卡片並高亮
  // 若站點不在目前過濾清單(被城市/搜尋/只看有車過濾掉),自動清除過濾讓它出現
  useEffect(() => {
    if (!selectedId || !listRef.current) return;
    const el = cardRefs.current[selectedId];
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      return;
    }
    // 找不到卡片 → 該站被過濾掉了,清空過濾條件讓它浮現,下一輪再捲動
    const st = stations.find((x) => x.id === selectedId);
    if (!st) return;
    if (city !== 'all' && st.city !== city) {
      setCity('all');
      setQuery('');
      setOnlyAvailable(false);
      setShowFavOnly(false);
    } else if ((query || onlyAvailable || showFavOnly) && !filtered.some((x) => x.id === selectedId)) {
      setQuery('');
      setOnlyAvailable(false);
      setShowFavOnly(false);
    }
  }, [selectedId, filtered, stations, city, query, onlyAvailable, showFavOnly]);

  const selected = filtered.find((s) => s.id === selectedId) ||
    stations.find((s) => s.id === selectedId) || null;

  const mapCenter =
    mapCenterOverride
      ? mapCenterOverride
      : areaTarget
        ? { center: areaTarget.center, zoom: 13 }
        : selected && selected.lat
          ? { center: [selected.lat, selected.lng], zoom: 15 }
          : CITY_ZOOM[city];

  const fmtTime = (t) =>
    t ? new Date(t).toLocaleTimeString('zh-TW', { hour12: false }) : '—';

  const favCount = favorites.length;
  const clusteredCount = useMemo(
    () => filtered.filter((s) => clusteredIds.has(s.id) && s.id !== selectedId).length,
    [filtered, clusteredIds, selectedId]
  );

  // 鍵盤導航
  const focusIndex = useRef(-1);
  useEffect(() => {
    function onKey(e) {
      if (e.key === '/' && document.activeElement?.tagName !== 'INPUT') {
        e.preventDefault();
        document.querySelector('.search')?.focus();
      } else if (e.key === 'Escape') {
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
            <button className={'icon-btn' + (userLoc ? ' loc-on' : '')} onClick={locate} title="定位離我最近" aria-label="定位">
              📍
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

      <div className="controls">
        <input
          className="search"
          placeholder="搜尋站名 / 區域 / 地址(輸入區名地圖會飛過去)/"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        {areaTarget && (
          <div className="area-hint">🗺️ 偵測到「{areaTarget.name}」{areaTarget.count} 站 — 地圖已定位</div>
        )}
        <div className="chips">
          {CITIES.map((c) => (
            <button
              key={c}
              className={'chip' + (city === c ? ' active' : '')}
              onClick={() => {
                setCity(c);
                // 切換城市時,若選中的站不在該城市,取消選取(避免站點跨區殘留)
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

      <div className="main">
        <ul className="list" ref={listRef}>
          {loading &&
            Array.from({ length: 8 }).map((_, i) => (
              <li key={i} className="card skeleton">
                <div className="sk-line w60" />
                <div className="sk-line w80" />
                <div className="sk-line w40" />
              </li>
            ))}
          {!loading && rangeStats && rangeStats.emptyStations > 0 && (
            <li>
              <button
                className={'low-badge-btn' + (lowOnly ? ' on' : '')}
                onClick={() => setLowOnly((v) => !v)}
              >
                ⚠️ 此範圍內有 {rangeStats.emptyStations} 個無車站 — 點此{lowOnly ? '顯示全部' : '只看它們'}
              </button>
            </li>
          )}
          {!loading && clusteredCount > 0 && (
            <li className="cluster-hint">另有 {clusteredCount} 站已聚合於地圖(拉近即可展開)</li>
          )}
          {!loading &&
            displayList.map((s) => {
              const isFav = favorites.includes(s.id);
              const tr = trend(s.id);
              const mm = minmax(s.id);
              // 進度條:可停空位比例(有車位資料時);無則用可借比例
              const denom = s.total > 0 ? s.total : (s.available + (s.empty ?? 0));
              const pct = denom > 0 ? Math.round((s.available / denom) * 100) : 0;
              const low = s.active && s.available <= (notifSettings.threshold ?? 3);
              return (
                <li
                  key={s.id}
                  ref={(el) => (cardRefs.current[s.id] = el)}
                  className={
                    'card' +
                    (s.id === selectedId ? ' selected glow' : '') +
                    (low ? ' low-station' : '')
                  }
                  onClick={() => pick(s)}
                >
                  <div className="card-top">
                    <span className={`city-badge b-${s.city}`}>{s.city}</span>
                    <span className="name">{s.name}</span>
                    <button
                      className={'star' + (isFav ? ' on' : '')}
                      onClick={(e) => {
                        e.stopPropagation();
                        toggleFavorite(s.id);
                      }}
                      aria-label="收藏"
                    >
                      {isFav ? '★' : '☆'}
                    </button>
                  </div>
                  <div className="addr">{s.area} · {s.addr}</div>
                  <div className="counts">
                    {!s.active ? (
                      <span className="inactive-tag">⛔ 暫停營運</span>
                    ) : (
                      <>
                        {s.regularBikes != null && (
                          <span className="bike-type" title="一般自行車">🚲 <AnimatedNumber value={s.regularBikes} /></span>
                        )}
                        {s.ebikes != null && s.ebikes > 0 && (
                          <span className="bike-type ebike" title="電輔車">⚡ <AnimatedNumber value={s.ebikes} /></span>
                        )}
                        {(s.regularBikes == null || s.ebikes == null) && (
                          <span className="avail" title="臺北官方 API 未提供車型明細,此為一般+電輔總數">🚲 可借 <AnimatedNumber value={s.available} /></span>
                        )}
                        <span className="free" title="可停空位">🅿️ 可停 <AnimatedNumber value={s.empty ?? 0} /></span>
                        {tr && tr !== 'flat' && (
                          <span className={'trend ' + tr}>{tr === 'up' ? '↑' : '↓'} 車流中</span>
                        )}
                      </>
                    )}
                    {mm && (
                      <span className="minmax" title="近 2 小時最低/最高可借數">
                        ↓{mm.min} ↑{mm.max}
                      </span>
                    )}
                    {s.dist != null && s.dist < 100000 && (
                      <span className="dist">{s.dist >= 1000 ? (s.dist / 1000).toFixed(1) + 'km' : Math.round(s.dist) + 'm'}</span>
                    )}
                    <a
                      className="nav-link"
                      href={`https://www.google.com/maps/dir/?api=1&destination=${s.lat},${s.lng}`}
                      target="_blank"
                      rel="noreferrer"
                      onClick={(e) => e.stopPropagation()}
                    >
                      導航 ↗
                    </a>
                  </div>
                  <div className="bar">
                    <div className={'fill' + (low ? ' fill-low' : '')} style={{ width: Math.min(pct, 100) + '%' }} />
                  </div>
                </li>
              );
            })}
          {!loading && filtered.length === 0 && <li className="no-result">沒有符合的站點</li>}
          {filtered.length > 300 && <li className="no-result">僅顯示前 300 筆,請縮小搜尋範圍</li>}
        </ul>

        <MapView
          stations={filtered}
          center={mapCenter.center}
          zoom={mapCenter.zoom}
          onSelect={pick}
          selected={selected}
          theme={theme}
          userLoc={userLoc}
          onBoundsChange={(b, z) => { setMapBounds(b); setMapZoom(z); }}
          onClusteredChange={(ids) => setClusteredIds(new Set(ids))}
          areaTarget={areaTarget}
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
  const pts = history.filter((p) => p.t >= cutoff);
  const w = 560, h = 170, pad = 30;

  const maxA = Math.max(...pts.map((p) => p.a), station.total || 5, 5);
  const maxE = Math.max(...pts.map((p) => p.e ?? 0), 5);
  const yMax = Math.max(maxA, maxE);
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

'use client';

import { MapContainer, TileLayer, Marker, Popup, ZoomControl, useMap, useMapEvents } from 'react-leaflet';
import MarkerClusterGroup from 'react-leaflet-markercluster';
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import 'react-leaflet-markercluster/styles';
import { markersWithinBounds, paddedMarkerBounds, viewportWithinMarkerBounds } from '../lib/map-viewport.mjs';
import { isMapBackgroundClick } from '../lib/map-selection.mjs';

// OSM standard 圖磚:道路分級配色、綠地公園可見(最接近 Google 地圖觀感)
const TILE = {
  url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
  attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
};

const bubbleIconCache = new Map();

// 數字氣泡圖標:沒車顯示 0、不能還車顯示 M、暫停營運灰底顯示車數
function bubbleIcon(s) {
  const key = `${s.active ? 1 : 0}:${s.available}:${s.empty ?? ''}`;
  const cached = bubbleIconCache.get(key);
  if (cached) return cached;

  const isFullDock = s.empty === 0 && s.available > 0;
  let color, label;
  if (!s.active) {
    color = '#9b9ba3';
    label = isFullDock ? 'M' : String(s.available);
  } else {
    color = isFullDock ? '#e060a5' : s.available === 0 ? '#e5484d' : s.available <= 3 ? '#f5a623' : '#30a46c';
    label = isFullDock ? 'M' : String(s.available);
  }
  const scale = label.length > 1 ? (label.length > 2 ? 36 : 31) : 24;
  const icon = L.divIcon({
    className: 'yb-bubble-wrap',
    html: `<div class="yb-bubble${!s.active ? ' dim' : ''}" style="--bc:${color};width:${scale}px;height:${scale}px">${label}</div>`,
    iconSize: [scale, scale],
    iconAnchor: [0, scale],
  });
  bubbleIconCache.set(key, icon);
  return icon;
}

function Recenter({ center, zoom, trigger }) {
  const map = useMap();
  const lat = center?.[0], lng = center?.[1];
  useEffect(() => {
    if (lat == null || lng == null) return;
    // 只要 center 或 zoom 變了就飛過去（由父層明確觸發的 fly-to，不應被距離閾值擋住）
    map.flyTo([lat, lng], zoom, { duration: 0.8 });
  }, [map, lat, lng, zoom, trigger]);
  return null;
}

function ResizeInvalidator() {
  const map = useMap();
  useEffect(() => {
    const container = map.getContainer();
    const observer = new ResizeObserver(() => map.invalidateSize({ pan: false }));
    observer.observe(container);
    return () => observer.disconnect();
  }, [map]);
  return null;
}

function BoundsReporter({ onViewport }) {
  const timerRef = useRef(null);
  const onViewportRef = useRef(onViewport);
  onViewportRef.current = onViewport;
  const map = useMapEvents({
    // 合併 Leaflet 在縮放結束時可能連續送出的 moveend，只回報最後一次。
    moveend: () => {
      window.clearTimeout(timerRef.current);
      timerRef.current = window.setTimeout(
        () => onViewportRef.current(map.getBounds(), map.getZoom()),
        80
      );
    },
  });
  useEffect(() => {
    onViewportRef.current(map.getBounds(), map.getZoom());
    return () => window.clearTimeout(timerRef.current);
  }, [map]);
  return null;
}

function UserSelectionDismissal({ onDismiss }) {
  useMapEvents({
    dragstart: onDismiss,
    click: event => { if (isMapBackgroundClick(event)) onDismiss(); },
    keydown: event => { if (event.originalEvent?.key === 'Escape') onDismiss(); },
  });
  return null;
}

function SelectedPopupOpener({ station, requestToken, onOpen }) {
  const map = useMap();
  const handledTokenRef = useRef(0);

  useEffect(() => {
    if (!station || requestToken === handledTokenRef.current) return;

    let opened = false;
    const open = () => {
      if (opened) return;
      opened = true;
      handledTokenRef.current = requestToken;
      onOpen(station);
    };

    map.once('moveend', open);
    // 同站重選時 Leaflet 可能不送 moveend，仍要比照點擊圖標開啟詳情。
    const fallback = window.setTimeout(open, 950);
    return () => {
      map.off('moveend', open);
      window.clearTimeout(fallback);
    };
  }, [map, station, requestToken, onOpen]);

  return null;
}

const meIcon = L.divIcon({
  className: 'yb-me-wrap',
  html: '<div class="yb-me"></div>',
  iconSize: [18, 18],
  iconAnchor: [9, 9],
});

const StationMarker = memo(function StationMarker({ s, onOpen }) {
  return (
    <Marker
      position={[s.lat, s.lng]}
      icon={bubbleIcon(s)}
      ybId={s.id}
      eventHandlers={{ click: () => onOpen(s) }}
    />
  );
});

function currentViewportBounds(map) {
  const bounds = map.getBounds();
  return {
    south: bounds.getSouth(),
    west: bounds.getWest(),
    north: bounds.getNorth(),
    east: bounds.getEast(),
  };
}

function ViewportStationMarkers({ stations, selectedId, markerSetKey, onOpen }) {
  const map = useMap();
  const [markerWindow, setMarkerWindow] = useState(() => ({
    bounds: paddedMarkerBounds(currentViewportBounds(map)),
    zoom: map.getZoom(),
  }));
  const refreshBounds = useCallback(() => {
    const viewport = currentViewportBounds(map);
    const zoom = map.getZoom();
    setMarkerWindow((previous) => {
      if (previous.zoom === zoom && viewportWithinMarkerBounds(viewport, previous.bounds)) {
        return previous;
      }
      return { bounds: paddedMarkerBounds(viewport), zoom };
    });
  }, [map]);

  // 拖曳時由 Leaflet 自行移動圖層，只在移動結束後更新圖標集合。
  useMapEvents({ moveend: refreshBounds, resize: refreshBounds });
  useEffect(() => { refreshBounds(); }, [refreshBounds]);

  const nearbyStations = useMemo(
    () => markersWithinBounds(stations, markerWindow.bounds, selectedId),
    [stations, markerWindow.bounds, selectedId]
  );

  return (
    <MarkerClusterGroup
      key={markerSetKey}
      showCoverageOnHover={false}
      maxClusterRadius={20}
      disableClusteringAtZoom={15}
      zoomToBoundsOnClick
      spiderfyOnMaxZoom={false}
      chunkedLoading
    >
      {nearbyStations.map((s) => <StationMarker key={s.id} s={s} onOpen={onOpen} />)}
    </MarkerClusterGroup>
  );
}

function StationPopup({ station, onDismiss }) {
  const [shareStatus, setShareStatus] = useState('');
  const shareStatusTimerRef = useRef(null);
  const hasBikeBreakdown = station.regularBikes != null || station.ebikes != null;
  const position = useMemo(() => [station.lat, station.lng], [station.lat, station.lng]);

  useEffect(
    () => () => window.clearTimeout(shareStatusTimerRef.current),
    []
  );

  const showShareStatus = (message) => {
    window.clearTimeout(shareStatusTimerRef.current);
    setShareStatus(message);
    shareStatusTimerRef.current = window.setTimeout(() => setShareStatus(''), 2400);
  };

  const shareStation = async () => {
    const url = new URL(window.location.href);
    url.searchParams.set('station', station.id);
    const shareUrl = url.toString();
    const shareData = {
      title: `YouBike｜${station.name}`,
      text: `${station.name} YouBike 站點`,
      url: shareUrl,
    };

    if (typeof navigator.share === 'function') {
      try {
        await navigator.share(shareData);
        return;
      } catch (error) {
        if (error?.name === 'AbortError') return;
      }
    }

    try {
      await navigator.clipboard.writeText(shareUrl);
      showShareStatus('已複製連結');
    } catch {
      showShareStatus('請複製網址列');
    }
  };

  return (
    <Popup
      position={position}
      className="station-popup"
      minWidth={210}
      maxWidth={224}
      autoPanPadding={[16, 16]}
      closeButton={false}
      closeOnClick={false}
      closeOnEscapeKey={false}
    >
      <button type="button" className="leaflet-popup-close-button" style={{ position: 'absolute', border: 0, cursor: 'pointer' }} aria-label="關閉站點資訊" onClick={onDismiss}>×</button>
      <article className="popup-card" aria-label={`${station.name}站點資訊`}>
        <div className="popup-meta">
          <span className={`popup-city b-${station.city}`}>{station.city}</span>
          <span className={`popup-status ${station.active ? 'is-active' : 'is-inactive'}`}>
            <i aria-hidden="true" />
            {station.active ? '營運中' : '暫停營運'}
          </span>
        </div>

        <h2 className="popup-title">{station.name}</h2>

        {station.active ? (
          <div className="popup-metrics">
            <div className={`popup-metric popup-metric-bike ${station.available === 0 ? 'is-zero' : ''}`}>
              <span className="popup-metric-label"><span aria-hidden="true">🚲</span> 可借車輛</span>
              <span className="popup-metric-value">{station.available}<small>輛</small></span>
            </div>
            <div className={`popup-metric popup-metric-dock ${station.empty === 0 ? 'is-zero' : ''}`}>
              <span className="popup-metric-label"><span aria-hidden="true">P</span> 可停空位</span>
              <span className="popup-metric-value">{station.empty ?? '—'}<small>格</small></span>
            </div>
          </div>
        ) : (
          <div className="popup-inactive-panel">
            <span aria-hidden="true">!</span>
            此站目前暫停提供借還服務
          </div>
        )}

        {station.active && hasBikeBreakdown && (
          <div className="popup-breakdown" aria-label="車型明細">
            <span>一般車 <strong>{station.regularBikes ?? '—'}</strong></span>
            <i aria-hidden="true" />
            <span>電輔車 <strong>{station.ebikes ?? '—'}</strong></span>
          </div>
        )}

        <div className="popup-location">
          <span className="popup-location-icon" aria-hidden="true">⌖</span>
          <div>
            <strong>{station.area}</strong>
            <span>{station.addr}</span>
          </div>
        </div>

        <a
          href={`https://www.google.com/maps/dir/?api=1&destination=${station.lat},${station.lng}`}
          target="_blank"
          rel="noreferrer"
          className="popup-nav-link"
          aria-label={`導航到${station.name}`}
        >
          <span aria-hidden="true">➜</span>
          開始導航
          <small aria-hidden="true">開啟 Google 地圖 ↗</small>
        </a>

        <button
          type="button"
          className="popup-share-button"
          aria-label="分享站點"
          onClick={shareStation}
        >
          <span aria-hidden="true">↗</span>
          <span aria-live="polite">{shareStatus || '分享站點'}</span>
        </button>
      </article>
    </Popup>
  );
}

export default function MapView({ stations, center, zoom, onSelect, onDeselect, selected, userLoc, onBoundsChange, recenterToken, popupRequestToken, markerSetKey, onInteraction }) {
  const [popupState, setPopupState] = useState(null);
  // 所有站點資料仍保留給列表、搜尋及跨縣市選站，只有地圖圖標按視野裁切。
  const visible = useMemo(
    () => stations.filter((s) => Number.isFinite(s.lat) && Number.isFinite(s.lng)),
    [stations]
  );

  const selVisible = selected && !visible.some((v) => v.id === selected.id) ? selected : null;
  const popupStationId = popupState?.station.id ?? null;
  const activePopupState = popupStationId === selected?.id ? popupState : null;
  const selectedRef = useRef(selected);
  selectedRef.current = selected;
  const dismissPopup = useCallback(() => {
    setPopupState(null);
    onDeselect?.();
  }, [onDeselect]);

  const showPopup = useCallback((station) => {
    if (selectedRef.current?.id !== station.id) return;
    setPopupState((previous) => ({
      station,
      sequence: (previous?.sequence ?? 0) + 1,
    }));
  }, []);

  useEffect(() => {
    if (popupStationId && popupStationId !== selected?.id) setPopupState(null);
  }, [popupStationId, selected?.id]);

  const openStation = useCallback((station) => {
    onSelect(station, { recenter: false });
    // 等本次 Leaflet click 完整結束後再開啟，避免同一個 map click 立刻關閉新 popup。
    window.setTimeout(() => showPopup(station), 0);
  }, [onSelect, showPopup]);

  return (
    <div className="map-wrap" onPointerDown={onInteraction} onWheel={onInteraction}>
      <MapContainer
        center={center}
        zoom={zoom}
        zoomSnap={0.5}
        zoomDelta={1}
        wheelPxPerZoomLevel={20}
        scrollWheelZoom
        zoomControl={false}
        className="map"
        preferCanvas
      >
        <TileLayer attribution={TILE.attribution} url={TILE.url} />
        <ZoomControl position="bottomleft" />
        <ResizeInvalidator />
        <Recenter center={center} zoom={zoom} trigger={recenterToken} />
        <UserSelectionDismissal onDismiss={dismissPopup} />
        <SelectedPopupOpener
          station={selected}
          requestToken={popupRequestToken}
          onOpen={showPopup}
        />
        <BoundsReporter
          onViewport={(nextBounds, nextZoom) => {
            onBoundsChange?.(
              {
                south: nextBounds.getSouth(),
                west: nextBounds.getWest(),
                north: nextBounds.getNorth(),
                east: nextBounds.getEast(),
              },
              nextZoom
            );
          }}
        />
        <ViewportStationMarkers
          stations={visible}
          selectedId={selected?.id}
          markerSetKey={markerSetKey}
          onOpen={openStation}
        />
        {activePopupState && (
          <StationPopup
            key={`${activePopupState.station.id}:${activePopupState.sequence}`}
            station={activePopupState.station}
            onDismiss={dismissPopup}
          />
        )}
        {selVisible && (
          <Marker position={[selVisible.lat, selVisible.lng]} icon={bubbleIcon(selVisible)} zIndexOffset={2000} eventHandlers={{ click: () => onSelect(selVisible) }} />
        )}
        {userLoc && !isNaN(userLoc.lat) && <Marker position={[userLoc.lat, userLoc.lng]} icon={meIcon}>
          <Popup>📍 您在這裡</Popup>
        </Marker>}
      </MapContainer>
      <div className="legend glass">
        <span><i style={{ background: '#30a46c' }} />充足</span>
        <span><i style={{ background: '#f5a623' }} />≤3 輛</span>
        <span><i style={{ background: '#e5484d' }} />無車</span>
        <span><i style={{ background: '#e060a5' }} />已滿（可借車）</span>
        <span><i style={{ background: '#9b9ba3' }} />暫停</span>
      </div>
    </div>
  );
}

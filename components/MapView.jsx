'use client';

import { MapContainer, TileLayer, Marker, Popup, useMap, useMapEvents } from 'react-leaflet';
import MarkerClusterGroup from 'react-leaflet-markercluster';
import { useEffect, useMemo, useState, useRef } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import 'react-leaflet-markercluster/styles';

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
    iconAnchor: [scale / 2, scale / 2],
  });
  bubbleIconCache.set(key, icon);
  return icon;
}

function Recenter({ center, zoom }) {
  const map = useMap();
  const lat = center?.[0], lng = center?.[1];
  useEffect(() => {
    if (lat == null || lng == null) return;
    // 只要 center 或 zoom 變了就飛過去（由父層明確觸發的 fly-to，不應被距離閾值擋住）
    map.flyTo([lat, lng], zoom, { duration: 0.8 });
  }, [map, lat, lng, zoom]);
  return null;
}

function BoundsReporter({ onBounds, onZoom }) {
  const map = useMapEvents({
    // 只在 moveend(平移結束)與 zoomend(縮放完成)後重新統計,拖曳中不觸發
    moveend: () => onBounds(map.getBounds(), map.getZoom()),
    zoomend: () => { onZoom(map.getZoom()); onBounds(map.getBounds(), map.getZoom()); },
  });
  useEffect(() => {
    onZoom(map.getZoom());
    onBounds(map.getBounds(), map.getZoom());
  }, []);
  return null;
}

function zoomIntoCluster(event) {
  const map = event.target?.getMap?.();
  const cluster = event.layer;
  if (!map || !cluster) return;
  map.flyTo(cluster.getLatLng(), Math.min(15, map.getMaxZoom()), { duration: 0.45 });
}

const meIcon = L.divIcon({
  className: 'yb-me-wrap',
  html: '<div class="yb-me"></div>',
  iconSize: [18, 18],
  iconAnchor: [9, 9],
});

function StationMarker({ s, selected, onSelect }) {
  return (
    <Marker
      position={[s.lat, s.lng]}
      icon={bubbleIcon(s)}
      zIndexOffset={s.id === selected?.id ? 1000 : 0}
      ybId={s.id}
      eventHandlers={{ popupopen: () => onSelect(s, { recenter: false }) }}
    >
      <Popup>
        <div className="popup-card">
          <b>{s.name}</b>
          <div className="popup-counts">
            {!s.active ? (
              <span className="popup-inactive">⛔ 暫停營運</span>
            ) : (
              <>
                {s.regularBikes != null && (
                  <span style={{ color: '#27a644', fontWeight: 700 }}>🚲 一般 {s.regularBikes}</span>
                )}
                {s.ebikes != null && s.ebikes > 0 && (
                  <span style={{ color: '#b8860b', fontWeight: 700 }}>⚡ 電輔 {s.ebikes}</span>
                )}
                {(s.regularBikes == null || s.ebikes == null) && (
                  <span style={{ color: '#27a644', fontWeight: 700 }}>🚲 可借 {s.available}</span>
                )}
                <span style={{ color: '#5e6ad2' }}>🅿️ 可停 {s.empty ?? '?'}</span>
              </>
            )}
          </div>
          <div className="popup-addr">{s.area} · {s.addr}</div>
          <a
            href={`https://www.google.com/maps/dir/?api=1&destination=${s.lat},${s.lng}`}
            target="_blank"
            rel="noreferrer"
            className="popup-nav-link"
          >
            導航到此站 ↗
          </a>
        </div>
      </Popup>
    </Marker>
  );
}

export default function MapView({ stations, center, zoom, onSelect, selected, userLoc, onBoundsChange, onClusteredChange }) {
  const [bounds, setBounds] = useState(null);
  const [curZoom, setCurZoom] = useState(zoom);
  const groupRef = useRef(null);

  // 只渲染可見範圍內的站點(效能關鍵)
  // bounds 以 ref 持有,避免拖曳中重算;zoomend/moveend 後才 setState
  const visible = useMemo(() => {
    if (!bounds) return [];
    const padded = bounds.pad(0.1);
    return stations.filter((s) => {
      if (isNaN(s.lat) || isNaN(s.lng)) return false;
      return padded.contains([s.lat, s.lng]);
    }).slice(0, 600);
  }, [stations, bounds]);

  const selVisible = selected && !visible.some((v) => v.id === selected.id) ? selected : null;

  // 回報 bounds 給 page(列表過濾)+ 回報目前被聚合的站
  const cbRef = useRef({});
  cbRef.current = { onBoundsChange, onClusteredChange };
  useEffect(() => {
    if (!bounds) return;
    const { onBoundsChange } = cbRef.current;
    onBoundsChange?.(
      {
        south: bounds.getSouth(),
        west: bounds.getWest(),
        north: bounds.getNorth(),
        east: bounds.getEast(),
      },
      curZoom
    );
  }, [bounds, curZoom]);

  useEffect(() => {
    if (!onClusteredChange) return;
    const group = groupRef.current;
    if (!group || !group.eachLayer || !group.getMap) { onClusteredChange([]); return; }
    const z = curZoom;
    const ids = [];
    // 透過內部 __parent 判斷:可見父節點不是自己且父節點含超過1個子站 = 被聚合
    group.eachLayer((layer) => {
      const sid = layer?.options?.ybId;
      if (!sid) return;
      let v = layer;
      // 往上找到當前 zoom 仍屬於同一群組的父節點
      while (v.__parent && v.__parent._zoom >= z) v = v.__parent;
      // v 為最終可見父節點;若 v !== layer 且 v 含 >1 子站,才算被聚合
      if (v !== layer && v.getChildCount() > 1) ids.push(sid);
    });
    // 去重
    cbRef.current.onClusteredChange?.([...new Set(ids)]);
  }, [visible, curZoom]);
  return (
    <div className="map-wrap">
      <MapContainer center={center} zoom={zoom} scrollWheelZoom className="map" preferCanvas>
        <TileLayer attribution={TILE.attribution} url={TILE.url} />
        <Recenter center={center} zoom={zoom} />
        <BoundsReporter
          onBounds={(b, z) => { setBounds(b); onBoundsChange?.(b, z); }}
          onZoom={setCurZoom}
        />
        {curZoom >= 15 ? (
          visible.map((s) => <StationMarker key={s.id} s={s} selected={selected} onSelect={onSelect} />)
        ) : (
          <MarkerClusterGroup
            showCoverageOnHover={false}
            maxClusterRadius={20}
            disableClusteringAtZoom={15}
            zoomToBoundsOnClick={false}
            spiderfyOnMaxZoom={false}
            chunkedLoading
            onClick={zoomIntoCluster}
            whenReady={(group) => { groupRef.current = group; }}
          >
            {visible.map((s) => <StationMarker key={s.id} s={s} selected={selected} onSelect={onSelect} />)}
          </MarkerClusterGroup>
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
        <span><i style={{ background: '#9b9ba3' }} />暫停</span>
      </div>
    </div>
  );
}

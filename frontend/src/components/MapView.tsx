/**
 * Mapa compartido (Leaflet + OpenStreetMap) para el módulo de reparto.
 * Uso imperative: inicializa el mapa una vez y actualiza marcadores/recorrido
 * cuando cambian las props. No usa imágenes del paquete (circleMarker +
 * divIcon) para evitar el clásico bug de iconos rotos con bundlers.
 * Los tiles requieren la excepción de CSP img-src ya agregada en el backend.
 */
import { useEffect, useRef } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';

export interface MapMarker {
  id: string;
  lat: number;
  lng: number;
  /** Texto del popup (HTML plano seguro: construimos nosotros, no user-input crudo) */
  popup: string;
  tooltip?: string;
  /** Tono del marcador */
  tone?: 'vehicle' | 'stop' | 'pending' | 'branch';
  /** Es la posición del vehículo que se sigue (centrar el mapa acá) */
  focus?: boolean;
}

export interface MapPathPoint {
  lat: number;
  lng: number;
}

const TONE_STYLE: Record<NonNullable<MapMarker['tone']>, { color: string; icon: string; radius: number }> = {
  vehicle: { color: '#2563eb', icon: '🚐', radius: 8 },
  stop: { color: '#16a34a', icon: '', radius: 6 },
  pending: { color: '#f59e0b', icon: '', radius: 6 },
  branch: { color: '#475569', icon: '', radius: 5 },
};

interface MapViewProps {
  markers: MapMarker[];
  /** Recorrido GPS (polyline) del vehículo */
  path?: MapPathPoint[];
  /** Centrar/hacer zoom sobre el marcador con focus=true cuando cambia `followKey` */
  followKey?: string | number;
  height?: string;
  className?: string;
}

export default function MapView({ markers, path, followKey, height = 'h-[420px]', className = '' }: MapViewProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<L.Map | null>(null);
  const markersLayerRef = useRef<L.LayerGroup | null>(null);
  const pathLayerRef = useRef<L.LayerGroup | null>(null);
  const didFitRef = useRef(false);

  // Init del mapa (una sola vez)
  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;
    const map = L.map(containerRef.current, {
      center: [-34.6, -58.45], // CABA aprox; se re-centra con los marcadores
      zoom: 12,
      scrollWheelZoom: true,
    });
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
    }).addTo(map);
    markersLayerRef.current = L.layerGroup().addTo(map);
    pathLayerRef.current = L.layerGroup().addTo(map);
    mapRef.current = map;
    return () => {
      map.remove();
      mapRef.current = null;
      markersLayerRef.current = null;
      pathLayerRef.current = null;
    };
  }, []);

  // Marcadores
  useEffect(() => {
    const layer = markersLayerRef.current;
    if (!layer) return;
    layer.clearLayers();

    const coords: L.LatLngExpression[] = [];
    let focusAt: L.LatLngExpression | null = null;

    for (const m of markers) {
      if (!Number.isFinite(m.lat) || !Number.isFinite(m.lng)) continue;
      const st = TONE_STYLE[m.tone ?? 'stop'];
      const marker = L.divIcon({
        className: '', // sin estilo default de leaflet
        html:
          st.icon
            ? `<div style="display:flex;align-items:center;justify-content:center;width:32px;height:32px;border-radius:50%;background:${st.color};border:3px solid #fff;box-shadow:0 2px 8px rgba(0,0,0,.35);font-size:17px">${st.icon}</div>`
            : `<div style="width:14px;height:14px;border-radius:50%;background:${st.color};border:2px solid #fff;box-shadow:0 1px 4px rgba(0,0,0,.4)"></div>`,
        iconSize: st.icon ? [32, 32] : [14, 14],
        iconAnchor: st.icon ? [16, 16] : [7, 7],
      });
      const mk = L.marker([m.lat, m.lng], { icon: marker, keyboard: false, title: m.tooltip ?? '' });
      if (m.popup) mk.bindPopup(`<div style="font-size:13px">${m.popup}</div>`);
      if (m.tooltip) mk.bindTooltip(m.tooltip, { direction: 'top', offset: [0, -14] });
      mk.addTo(layer);
      coords.push([m.lat, m.lng]);
      if (m.focus) focusAt = [m.lat, m.lng];
    }

    if (coords.length && !didFitRef.current) {
      mapRef.current?.fitBounds(L.latLngBounds(coords).pad(0.25), { maxZoom: 15 });
      didFitRef.current = true;
    } else if (focusAt && followKey !== undefined) {
      mapRef.current?.setView(focusAt, Math.max(mapRef.current?.getZoom() ?? 12, 14), { animate: true });
    }
  }, [markers, followKey]);

  // Polyline del recorrido GPS
  useEffect(() => {
    const layer = pathLayerRef.current;
    if (!layer) return;
    layer.clearLayers();
    if (path && path.length > 1) {
      const latlngs = path.filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lng)).map((p) => [p.lat, p.lng] as L.LatLngExpression);
      L.polyline(latlngs, { color: '#2563eb', weight: 3, opacity: 0.65 }).addTo(layer);
    }
  }, [path]);

  // Resize handler: si cambia el contenedor (tabs, sidebar), Leaflet necesita un re-render
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const ro = new ResizeObserver(() => map.invalidateSize());
    if (containerRef.current) ro.observe(containerRef.current);
    return () => ro.disconnect();
  }, []);

  return <div ref={containerRef} className={`w-full rounded-xl border border-slate-200 shadow-sm ${height} ${className}`} />;
}

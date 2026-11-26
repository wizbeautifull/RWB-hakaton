import { useEffect, useRef, useState } from 'react';
import { api } from './api';
import type { PointLocation } from './api';
import { Empty, useResource } from './ui';
import type { Mode } from './ui';

export type MapPoint = { id: string; name: string; location: PointLocation; available?: boolean };
type MapProps = { points: MapPoint[]; selectedId?: string; focusSelected?: boolean; onSelect: (id: string) => void };
type Coordinates = [longitude: number, latitude: number];
type Viewport = { center: Coordinates; zoom: number } | { bounds: [Coordinates, Coordinates] };
type Marker = { update: (props: { coordinates: Coordinates; zIndex: number }) => void };
type MapInstance = {
  addChild: (child: object) => void;
  removeChild: (child: Marker) => void;
  update: (props: { location: Viewport }) => void;
  destroy: () => void;
};
type YandexApi = {
  ready: Promise<unknown>;
  YMap: new (container: HTMLElement, props: { location: Viewport; margin: [number, number, number, number] }, layers: object[]) => MapInstance;
  YMapDefaultSchemeLayer: new (props: object) => object;
  YMapDefaultFeaturesLayer: new (props: object) => object;
  YMapMarker: new (props: { coordinates: Coordinates; zIndex: number }, element: HTMLElement) => Marker;
};

const moscow: Coordinates = [37.62, 55.75];
const coords = ({ longitude, latitude }: PointLocation): Coordinates => [longitude, latitude];
let yandexLoading: Promise<YandexApi> | undefined;

function markerTitle(point: MapPoint) {
  return [point.name, point.location.address,
    point.available === undefined ? undefined : point.available ? 'Подходит' : 'Мало места',
  ].filter(Boolean).join(' · ');
}

function mercatorLatitude(latitude: number) {
  const radians = Math.min(85.084, Math.max(-85.084, latitude)) * Math.PI / 180;
  const sine = Math.sin(radians);
  const eccentricity = 0.0818191908426;
  return Math.atanh(sine) - eccentricity * Math.atanh(eccentricity * sine);
}

function loadYandex(apiKey: string) {
  if (yandexLoading) return yandexLoading;
  yandexLoading = new Promise<YandexApi>((resolve, reject) => {
    const script = document.createElement('script');
    const url = new URL('https://api-maps.yandex.ru/v3/');
    url.search = new URLSearchParams({ apikey: apiKey, lang: 'ru_RU' }).toString();
    script.src = url.href;
    script.async = true;
    function failed() {
      clearTimeout(timer);
      script.remove();
      reject(new Error('Яндекс Карты недоступны'));
    }
    const timer = window.setTimeout(failed, 8_000);
    script.onerror = failed;
    script.onload = () => {
      const api = (window as Window & { ymaps3?: YandexApi }).ymaps3;
      if (!api?.ready) { failed(); return; }
      void api.ready.then(() => { clearTimeout(timer); resolve(api); }, failed);
    };
    document.head.append(script);
  }).catch(error => { yandexLoading = undefined; throw error; });
  return yandexLoading;
}

export function yandexUrl(location: PointLocation) {
  const pair = coords(location).join(',');
  return 'https://yandex.ru/maps/?' + new URLSearchParams({ ll: pair, pt: pair, z: '16' });
}

function MapWidget({ points, selectedId, focusSelected, onSelect }: MapProps) {
  const [exploring, setExploring] = useState(false);
  const selected = points.find(point => point.id === selectedId);
  const focus = focusSelected ? selected : undefined;
  const center = coords((focus ?? points[0]).location);
  const zoom = focus ? 15 : 12;
  const visible = (selected ? [selected, ...points.filter(point => point.id !== selectedId)] : points).slice(0, 30);
  const query = new URLSearchParams({
    ll: center.join(','), z: String(zoom),
    pt: visible.map(point => coords(point.location).join(',')).join('~'),
  });
  const worldSize = 256 * 2 ** zoom;
  const centerY = mercatorLatitude(center[1]);
  return <>
    <div className="supply-map__preview" role="region" aria-label="Метки ПВЗ">
      <iframe key={String(exploring)} className="supply-map__surface" title="Яндекс Карты · ПВЗ Wildberries"
        src={'https://yandex.ru/map-widget/v1/?' + query} loading="lazy" inert={!exploring}/>
      {!exploring && visible.map(point => {
        const longitudeDelta = ((point.location.longitude - center[0] + 540) % 360) - 180;
        const x = worldSize * longitudeDelta / 360;
        const y = worldSize * (centerY - mercatorLatitude(point.location.latitude)) / (2 * Math.PI);
        // Position each label beside the head of the widget's pin in the fixed viewport.
        const style = { left: `calc(50% + ${x + 17}px)`, top: `calc(50% + ${y - 35}px)` };
        const title = markerTitle(point);
        return <button key={point.id} type="button" className="supply-map__label" style={style} title={title}
          aria-label={title} aria-pressed={point.id === selectedId} disabled={point.available === false}
          tabIndex={-1} onClick={() => onSelect(point.id)}>{point.id}</button>;
      })}
    </div>
    <div className="supply-map__tools">
      <button type="button" className="button button--secondary" onClick={() => setExploring(value => !value)}>
        {exploring ? 'Показать буквы ПВЗ' : 'Перемещать карту'}
      </button>
    </div>
  </>;
}

function InteractiveMap({ points, selectedId, focusSelected, onSelect, apiKey }: MapProps & { apiKey: string }) {
  const container = useRef<HTMLDivElement>(null);
  const [instance, setInstance] = useState<{ api: YandexApi; map: MapInstance }>();
  const [failed, setFailed] = useState(false);
  const markers = useRef(new Map<string, { marker: Marker; button: HTMLButtonElement }>());
  useEffect(() => {
    const target = container.current;
    const mountedMarkers = markers.current;
    let active = true;
    let map: MapInstance | undefined;
    void loadYandex(apiKey).then(api => {
      if (!active || !target) return;
      map = new api.YMap(target, { location: { center: moscow, zoom: 12 }, margin: [35, 35, 35, 35] }, [
        new api.YMapDefaultSchemeLayer({}), new api.YMapDefaultFeaturesLayer({}),
      ]);
      setInstance({ api, map });
    }).catch(() => { if (active) setFailed(true); });
    return () => { active = false; map?.destroy(); mountedMarkers.clear(); };
  }, [apiKey]);

  const focus = focusSelected ? points.find(point => point.id === selectedId) : undefined;
  const center = focus ?? (points.length === 1 ? points[0] : undefined);
  const focusLongitude = center?.location.longitude;
  const focusLatitude = center?.location.latitude;
  const longitudes = points.map(point => point.location.longitude);
  const latitudes = points.map(point => point.location.latitude);
  const west = Math.min(...longitudes);
  const east = Math.max(...longitudes);
  const south = Math.min(...latitudes);
  const north = Math.max(...latitudes);
  useEffect(() => {
    if (!instance) return;
    if (focusLongitude !== undefined && focusLatitude !== undefined) {
      instance.map.update({ location: { center: [focusLongitude, focusLatitude], zoom: 15 } });
    } else if (west === east && south === north) {
      instance.map.update({ location: { center: [west, south], zoom: 15 } });
    } else {
      instance.map.update({ location: { bounds: [[west, south], [east, north]] } });
    }
  }, [instance, focusLongitude, focusLatitude, west, east, south, north]);

  useEffect(() => {
    if (!instance) return;
    const { api, map } = instance;
    const removed = new Set(markers.current.keys());
    for (const point of points) {
      removed.delete(point.id);
      const pressed = selectedId === point.id;
      const props = { coordinates: coords(point.location), zIndex: pressed ? 3 : point.available === false ? 1 : 2 };
      let entry = markers.current.get(point.id);
      if (!entry) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'supply-map__marker';
        button.textContent = point.id;
        const marker = new api.YMapMarker(props, button);
        map.addChild(marker);
        entry = { marker, button };
        markers.current.set(point.id, entry);
      } else {
        entry.marker.update(props);
      }
      entry.button.disabled = point.available === false;
      entry.button.title = markerTitle(point);
      entry.button.setAttribute('aria-label', entry.button.title);
      entry.button.setAttribute('aria-pressed', String(pressed));
      entry.button.onclick = () => onSelect(point.id);
    }
    for (const id of removed) {
      map.removeChild(markers.current.get(id)!.marker);
      markers.current.delete(id);
    }
  }, [instance, points, selectedId, onSelect]);

  if (failed) return <MapWidget points={points} selectedId={selectedId} focusSelected={focusSelected} onSelect={onSelect}/>;
  return <>
    <div className="supply-map__surface" ref={container} role="region" aria-label="Яндекс Карты · ПВЗ Wildberries"/>
    {!instance && <span className="supply-map__loading" role="status">Загружаем Яндекс Карты…</span>}
  </>;
}

export function PickupMap({ mode, points, selectedId, focusSelected = true, onSelect }: MapProps & { mode: Mode }) {
  const useApi = mode === 'live' && points.length > 0;
  const config = useResource(() => useApi ? api.mapsConfig() : Promise.resolve({ yandex_api_key: null }), String(useApi));
  const apiKey = config.data?.yandex_api_key;
  if (!points.length) return <div className="supply-map supply-map--empty"><Empty>На карте пока нет точек. Выберите ПВЗ из списка.</Empty></div>;
  return <div className="supply-map">
    {apiKey ? <InteractiveMap key={apiKey} points={points} selectedId={selectedId} focusSelected={focusSelected} onSelect={onSelect} apiKey={apiKey}/>
      : <MapWidget points={points} selectedId={selectedId} focusSelected={focusSelected} onSelect={onSelect}/>}
  </div>;
}

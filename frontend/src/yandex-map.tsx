import { useEffect, useRef, useState } from 'react';
import type { PointLocation } from './api';
import { Empty } from './ui';

export type MapPoint = { id: string; name: string; location: PointLocation; available: boolean };
type MapProps = { points: MapPoint[]; selectedId?: string; onSelect: (id: string) => void };
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

function MapWidget({ points, selectedId }: Pick<MapProps, 'points' | 'selectedId'>) {
  const selected = points.find(point => point.id === selectedId);
  const center = selected ? coords(selected.location) : coords(points[0].location);
  const visible = selected ? [selected, ...points.filter(point => point.id !== selectedId)] : points;
  const query = new URLSearchParams({
    ll: center.join(','), z: selected ? '15' : '12',
    pt: visible.slice(0, 30).map(point => `${coords(point.location).join(',')},${point.id === selectedId ? 'pm2vvl' : point.available ? 'pm2vvm' : 'pm2grm'}`).join('~'),
  });
  return <iframe className="supply-map__surface" title="Яндекс Карты · ПВЗ Wildberries"
    src={'https://yandex.ru/map-widget/v1/?' + query} loading="lazy"/>;
}

function InteractiveMap({ points, selectedId, onSelect, apiKey }: MapProps & { apiKey: string }) {
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

  const selected = points.find(point => point.id === selectedId) ?? (points.length === 1 ? points[0] : undefined);
  const focusLongitude = selected?.location.longitude;
  const focusLatitude = selected?.location.latitude;
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
      const props = { coordinates: coords(point.location), zIndex: pressed ? 3 : point.available ? 2 : 1 };
      let entry = markers.current.get(point.id);
      if (!entry) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'supply-map__marker';
        button.textContent = 'WB';
        const marker = new api.YMapMarker(props, button);
        map.addChild(marker);
        entry = { marker, button };
        markers.current.set(point.id, entry);
      } else {
        entry.marker.update(props);
      }
      entry.button.disabled = !point.available;
      entry.button.title = `${point.name} · ${point.available ? 'Подходит' : 'Мало места'}`;
      entry.button.setAttribute('aria-label', entry.button.title);
      entry.button.setAttribute('aria-pressed', String(pressed));
      entry.button.onclick = () => onSelect(point.id);
    }
    for (const id of removed) {
      map.removeChild(markers.current.get(id)!.marker);
      markers.current.delete(id);
    }
  }, [instance, points, selectedId, onSelect]);

  if (failed) return <MapWidget points={points} selectedId={selectedId}/>;
  return <>
    <div className="supply-map__surface" ref={container} role="region" aria-label="Яндекс Карты · ПВЗ Wildberries"/>
    {!instance && <span className="supply-map__loading" role="status">Загружаем Яндекс Карты…</span>}
  </>;
}

export function PickupMap({ apiKey, ...props }: MapProps & { apiKey?: string | null }) {
  if (!props.points.length) return <div className="supply-map supply-map--empty"><Empty>Для отображения ПВЗ на карте нужны координаты.</Empty></div>;
  return <div className="supply-map">
    {apiKey ? <InteractiveMap key={apiKey} {...props} apiKey={apiKey}/>
      : <MapWidget points={props.points} selectedId={props.selectedId}/>}
  </div>;
}

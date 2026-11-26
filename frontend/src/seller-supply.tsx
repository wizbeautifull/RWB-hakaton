import { useState } from 'react';
import { CheckCircle2, ExternalLink, MapPin, PackagePlus } from 'lucide-react';
import type { Point } from './api';
import { Empty, Field } from './ui';
import type { Mode } from './ui';
import { PickupMap, yandexUrl } from './yandex-map';
import type { MapPoint } from './yandex-map';

const number = new Intl.NumberFormat('ru-RU');
const volumeLabel = (volume: number) => `${number.format(volume)} см³`;

export function SellerSupply({ mode, points }: { mode: Mode; points: Point[] }) {
  const [quantity, setQuantity] = useState('1');
  const [unitVolume, setUnitVolume] = useState('100');
  const [selectedId, setSelectedId] = useState('');
  const units = Number(quantity);
  const unit = Number(unitVolume);
  const valid = Number.isInteger(units) && units > 0 && units <= 1_000_000
    && Number.isInteger(unit) && unit > 0 && unit <= 1_000_000_000;
  const volume = valid ? units * unit : 0;
  const ranked = [...points].sort((a, b) => b.free_volume_cm3 - a.free_volume_cm3);
  const fits = (point: Point) => valid && point.free_volume_cm3 >= volume;
  const selected = ranked.find(point => point.id === selectedId && fits(point));
  const candidates = ranked.filter(fits).length;
  const mapPoints: MapPoint[] = ranked.flatMap(point => point.location ? [{
    id: point.id, name: point.name, location: point.location, available: fits(point),
  }] : []);

  return <section className="card supply-picker" aria-labelledby="supply-title">
    <div className="card__heading"><span className="card__icon"><PackagePlus size={21}/></span><h2 id="supply-title">Куда привезти поставку</h2></div>
    <div className="supply-picker__inputs">
      <Field label="Количество в поставке, шт."><input type="number" min="1" max="1000000" value={quantity} onChange={event => setQuantity(event.target.value)}/></Field>
      <Field label="Объём единицы, см³"><input type="number" min="1" max="1000000000" value={unitVolume} onChange={event => setUnitVolume(event.target.value)}/></Field>
      <p className="supply-picker__total" role="status">{valid
        ? <>Объём поставки <strong>{volumeLabel(volume)}</strong><small>Подходят {candidates} из {points.length} ПВЗ</small></>
        : 'Введите целое количество и объём в пределах полей.'}</p>
    </div>
    <div className="supply-picker__workspace">
      <PickupMap mode={mode} points={mapPoints} selectedId={selected?.id} onSelect={setSelectedId}/>
      <div className="supply-picker__choices">
        {ranked.length ? <ul className="supply-points" aria-label="ПВЗ для поставки">{ranked.map(point => {
          const available = fits(point);
          return <li key={point.id}><button type="button" className="supply-point" aria-pressed={selected?.id === point.id}
            disabled={!available} onClick={() => setSelectedId(point.id)}>
            <MapPin size={19} aria-hidden="true"/>
            <span className="supply-point__name"><strong>{point.name}</strong>{point.location?.address && <small>{point.location.address}</small>}
              <small>Свободно {volumeLabel(point.free_volume_cm3)}</small></span>
            {valid && <span className={`tag ${available ? 'tag--green' : 'tag--amber'}`}>{available ? 'Подходит' : 'Мало места'}</span>}
          </button></li>;
        })}</ul> : <Empty>В стенде пока нет ПВЗ для поставки.</Empty>}
      </div>
    </div>
    {selected ? <div className="supply-picker__selection" role="status">
      <CheckCircle2 size={20} aria-hidden="true"/>
      <div><strong>Выбран {selected.name}</strong><small>После поставки останется {volumeLabel(selected.free_volume_cm3 - volume)}. Место проверяется при приёмке.</small></div>
      {selected.location && <a className="text-link" href={yandexUrl(selected.location)} target="_blank" rel="noopener noreferrer">Яндекс Карты <ExternalLink size={16}/></a>}
    </div> : selectedId && valid && <p className="empty" role="status">В выбранном ПВЗ сейчас недостаточно места для этого объёма. Выберите другую точку.</p>}
  </section>;
}

import type { Order, Point, Product, Stock } from './api';

export const demoPoints: Point[] = [
  { id: 'A', name: 'ПВЗ Арбат', capacity_cm3: 1000, usable_capacity_cm3: 950, occupied_volume_cm3: 300, free_volume_cm3: 650,
    location: { longitude: 37.5979, latitude: 55.7521, address: 'Москва, район Арбат · демоточка' } },
  { id: 'B', name: 'ПВЗ Таганка', capacity_cm3: 1000, usable_capacity_cm3: 950, occupied_volume_cm3: 0, free_volume_cm3: 950,
    location: { longitude: 37.6559, latitude: 55.7417, address: 'Москва, Таганский район · демоточка' } },
];
export const demoProducts: Product[] = [{ sku: 'CABLE', seller_id: 'seller-1', unit_volume_cm3: 100 }];
const date = (minutes: number) => new Date(Date.now() + minutes * 60000).toISOString();
export const demoStock: Stock[] = [{
  ...demoProducts[0], seller_name: 'Магазин электроники', batch_id: 'lot-1', point_id: 'A', delivered_at: date(-1440), storage_days: 1,
  slow_stock: false, available: 2, reserved: 1, in_transit: 0, ready: 0, blocked: 0, damaged: 0,
}];
export const demoOrder: Order = {
  id: 'DEMO-001', scan_code: 'MESH-DEMO', sku: 'CABLE', quantity: 1, wb_club: true,
  pickup_point_id: 'B', source_point_id: 'A', actual_position: null, promised_by: date(2880),
  created_at: date(0), status: 'reserved', route_failure: null,
  route: {
    route_type: 'direct', pickup_point_id: 'B', source_point_id: 'A', hub_source_id: null,
    ready_at: date(160), estimated_unit_cost_kopecks: 16200, trip_id: 'demo-trip',
    reason: 'Прямой рейс укладывается в срок и дешевле хаба.', reason_code: 'direct_cheaper',
    alternatives: [{ route_type: 'hub', source_point_id: null, ready_at: date(1440), estimated_unit_cost_kopecks: 17200 }],
    evaluations: [], milestones: [],
  },
  next_actions: [{ type: 'pack', point_id: 'A' }], operations: [], accruals: [], accrual_total_kopecks: 0,
  allocations: [{ batch_id: 'lot-1', quantity: 1 }],
};

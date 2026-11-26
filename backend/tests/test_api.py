from concurrent.futures import ThreadPoolExecutor
from datetime import timedelta
from threading import Barrier, Lock
from uuid import uuid4

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, text

from backend.app.config import load_config
from backend.app.contracts import utc_now
from backend.app.integrations import PilotRouting
from backend.app.main import create_app
from backend.app.routing.models import DirectTrip, PickupPoint, Window


def register_points(client, capacity=1000):
    for point in ("A", "B", "C"):
        response = client.put(f"/api/points/{point}", json={"name": f"ПВЗ {point}", "capacity_cm3": capacity})
        assert response.status_code == 200, response.text


@pytest.fixture
def api(tmp_path):
    with TestClient(create_app(str(tmp_path / "test.sqlite3"))) as client:
        register_points(client)
        yield client


def batch_payload(point="A", quantity=3, *, days=1, batch_id="lot", sku="CABLE"):
    return {
        "request_id": uuid4().hex, "point_id": point, "batch_id": batch_id, "sku": sku,
        "seller_id": "seller", "quantity": quantity, "unit_volume_cm3": 100,
        "delivered_at": (utc_now() - timedelta(days=days, minutes=1)).isoformat(),
    }


def receive(client, *args, **kwargs):
    payload = batch_payload(*args, **kwargs)
    response = client.post("/api/batches", json=payload)
    assert response.status_code == 201, response.text
    return payload


def order_payload(point="B", wb_club=True, quantity=1, hours=48):
    return {
        "request_id": uuid4().hex, "sku": "CABLE", "pickup_point_id": point,
        "quantity": quantity, "wb_club": wb_club,
        "promised_by": (utc_now() + timedelta(hours=hours)).isoformat(),
    }


def create(client, *args, **kwargs):
    response = client.post("/api/orders", json=order_payload(*args, **kwargs))
    assert response.status_code == 201, response.text
    return response.json()


def act(client, order, kind, point, expected=200, **extra):
    payload = {
        "request_id": uuid4().hex, "type": kind, "point_id": point, "scan_code": order["scan_code"],
        **extra,
    }
    response = client.post(f"/api/orders/{order['id']}/actions", json=payload)
    assert response.status_code == expected, response.text
    return response.json()


def stock(client, point, batch_id="lot"):
    rows = client.get("/api/inventory", params={"point_id": point}).json()
    return next(row for row in rows if row["batch_id"] == batch_id)


def occupied(client, point):
    return next(row["occupied_volume_cm3"] for row in client.get("/api/points").json() if row["id"] == point)


def test_direct_full_flow_and_repeat_scan(api):
    receive(api)
    order = create(api)
    assert order["route"]["route_type"] == "direct"
    assert order["route"]["estimated_unit_cost_kopecks"] == 16_200
    assert stock(api, "A")["available"] == 2
    assert occupied(api, "A") == 300
    queue = api.get("/api/orders", params={"point_id": "A", "actionable": True}).json()
    assert [row["id"] for row in queue] == [order["id"]]
    assert act(api, order, "pack", "B", 409)["detail"]["code"] == "wrong_point"
    assert act(api, order, "pack", "A", 422, scan_code="wrong")["detail"]["code"] == "wrong_scan_code"
    assert act(api, order, "pack", "A")["status"] == "packed"
    key = uuid4().hex
    act(api, order, "handoff", "A", request_id=key)
    act(api, order, "handoff", "A", request_id=key)
    assert act(api, order, "handoff", "A", 409)["detail"]["code"] == "invalid_order_status"
    assert stock(api, "A")["in_transit"] == 1
    assert occupied(api, "A") == 200
    updated = act(api, order, "update_transit", "A", actual_position="на подъезде к Б")
    assert updated["actual_position"] == "на подъезде к Б"
    assert act(api, order, "receive", "C", 409)["detail"]["code"] == "wrong_point"
    assert act(api, order, "receive", "B")["status"] == "ready"
    assert occupied(api, "B") == 100
    done = act(api, order, "issue", "B")
    assert done["status"] == "delivered"
    assert {action["type"] for action in done["next_actions"]} == {"return_good", "return_damaged"}
    assert not done["pricing_pending"]
    assert done["accrual_total_kopecks"] == 4500
    assert [(entry["point_id"], entry["amount_kopecks"]) for entry in done["accruals"]] == [
        ("A", 1500), ("A", 500), ("B", 500), ("B", 2000),
    ]
    assert [event["type"] for event in done["operations"]] == [
        "order_created", "pack", "handoff", "update_transit", "receive", "issue",
    ]
    assert len({event["event_id"] for event in done["operations"]}) == 6
    assert stock(api, "A")["available"] == 2
    assert stock(api, "A")["in_transit"] == occupied(api, "B") == 0


def test_receipt_capacity_and_idempotency(api):
    accepted = receive(api, quantity=9)
    assert api.post("/api/batches", json=accepted).status_code == 201
    assert api.post("/api/batches", json={**accepted, "request_id": "another"}).status_code == 409
    conflict = api.post("/api/batches", json={**accepted, "quantity": 8})
    assert conflict.json()["detail"]["code"] == "request_id_conflict"
    excess = api.post("/api/batches", json=batch_payload(quantity=1, batch_id="extra"))
    assert excess.json()["detail"]["code"] == "capacity_exceeded"
    assert stock(api, "A")["available"] == 9
    assert len(api.get("/api/operations", params={"point_id": "A"}).json()) == 1


def test_shelf_reserve_and_cancel_across_batches(api):
    receive(api, quantity=1, days=8)
    receive(api, quantity=2, batch_id="new")
    order = create(api, "A", quantity=2)
    assert order["route"]["route_type"] == "shelf"
    assert stock(api, "A")["reserved"] == stock(api, "A", "new")["reserved"] == 1
    assert act(api, order, "pack", "A")["status"] == "ready"
    assert occupied(api, "A") == 300
    assert act(api, order, "cancel", "A")["status"] == "cancelled"
    assert stock(api, "A")["available"] == 1
    assert stock(api, "A", "new")["available"] == 2


def test_hub_confirmation_and_damaged_return(api):
    receive(api)
    order = create(api, wb_club=False)
    assert order["route"]["route_type"] == "hub"
    assert stock(api, "A")["available"] == 3
    assert act(api, order, "confirm_hub_delivery", "B")["status"] == "ready"
    act(api, order, "issue", "B")
    assert act(api, order, "return_damaged", "B")["status"] == "returned"
    batch_id = f"hub-{order['id']}"
    assert stock(api, "B", batch_id)["damaged"] == 1
    response = api.post(f"/api/inventory/B/{batch_id}/actions", json={
        "request_id": "damaged-to-hub", "type": "send_damaged_to_hub", "quantity": 1,
    })
    assert response.status_code == 200, response.text
    assert occupied(api, "B") == 0


def test_good_return_and_slow_stock_transfer(api):
    receive(api, days=40)
    order = create(api, "A", hours=3)
    act(api, order, "pack", "A")
    act(api, order, "issue", "A")
    act(api, order, "return_good", "A")
    assert stock(api, "A")["available"] == 3
    assert stock(api, "A")["slow_stock"]
    response = api.post("/api/inventory/A/lot/actions", json={
        "request_id": "transfer", "type": "move_slow", "quantity": 2, "destination_point_id": "C",
    })
    assert response.status_code == 200, response.text
    assert stock(api, "A")["available"] == 1
    assert stock(api, "C")["available"] == 2
    assert stock(api, "C")["storage_days"] == 40
    response = api.post("/api/inventory/C/lot/actions", json={
        "request_id": "remove", "type": "remove_slow", "quantity": 1,
    })
    assert response.status_code == 200, response.text
    assert stock(api, "C")["available"] == 1


def test_shortage_blocks_stock_and_replans_to_hub(api):
    receive(api, quantity=1)
    order = create(api)
    rerouted = act(api, order, "shortage", "A", shortage_batch_id="lot")
    assert rerouted["route"]["route_type"] == "hub"
    assert stock(api, "A")["blocked"] == 1
    assert stock(api, "A")["available"] == 0
    reconcile = api.post("/api/inventory/A/lot/actions", json={
        "request_id": "found", "type": "reconcile_found", "quantity": 1,
    })
    assert reconcile.status_code == 200, reconcile.text
    assert stock(api, "A")["available"] == 1
    assert stock(api, "A")["blocked"] == 0


def test_replan_without_route_commits_shortage(api):
    receive(api, quantity=1)
    order = create(api, hours=3)
    result = act(api, order, "shortage", "A")
    assert result["status"] == "awaiting_route"
    assert result["route"] is None and result["route_failure"]
    assert stock(api, "A")["blocked"] == 1
    receive(api, "C", batch_id="replacement")
    assert act(api, order, "replan", "B")["source_point_id"] == "C"


def test_receiving_rechecks_capacity_after_handoff(api):
    receive(api)
    order = create(api, quantity=2)
    act(api, order, "pack", "A")
    act(api, order, "handoff", "A")
    receive(api, "B", 8, batch_id="filler", days=35)
    assert act(api, order, "receive", "B", 409)["detail"]["code"] == "capacity_exceeded"
    assert stock(api, "A")["in_transit"] == 2
    assert api.post("/api/inventory/B/filler/actions", json={
        "request_id": "free-space", "type": "remove_slow", "quantity": 1,
    }).status_code == 200
    assert act(api, order, "receive", "B")["status"] == "ready"


@pytest.mark.parametrize(("trip_orders", "cost", "retained", "route"), [
    (8, 18_500, 0, "hub"),
    (10, 16_200, 0, "direct"),
    (10, 21_400, 5_200, "hub"),
    (10, 17_200, 1_000, "hub"),
])
def test_integrated_routing_rates(tmp_path, trip_orders, cost, retained, route):
    config = load_config()
    config.demo_routing.trip_orders = trip_orders
    config.demo_routing.retained_hub_unit_kopecks = retained
    with TestClient(create_app(str(tmp_path / "demo.sqlite3"), config=config)) as client:
        register_points(client)
        receive(client)
        result = create(client)["route"]
        direct = next(option for option in result["alternatives"] if option["route_type"] == "direct")
        assert direct["estimated_unit_cost_kopecks"] == cost
        assert result["route_type"] == route


def test_last_unit_concurrency_recalculates(tmp_path):
    config = load_config()
    barrier = Barrier(2, timeout=5)

    class SynchronizedRouter(PilotRouting):
        calls = 0
        lock = Lock()

        def choose(self, request):
            with self.lock:
                self.calls += 1
                first_snapshot = self.calls <= 2
            if first_snapshot:
                barrier.wait()
            return super().choose(request)

    router = SynchronizedRouter(config.demo_routing, config.logistics_pricing)
    with TestClient(create_app(str(tmp_path / "race.sqlite3"), config=config, routing=router)) as client:
        register_points(client)
        receive(client, quantity=1)
        payloads = [order_payload(), order_payload()]
        with ThreadPoolExecutor(2) as pool:
            responses = list(pool.map(lambda payload: client.post("/api/orders", json=payload), payloads))
        assert [response.status_code for response in responses] == [201, 201]
        assert {response.json()["route"]["route_type"] for response in responses} == {"direct", "hub"}
        assert stock(client, "A")["available"] == 0
        assert stock(client, "A")["reserved"] == 1
        assert router.calls == 3
        replay = client.post("/api/orders", json=payloads[0])
        assert replay.json()["id"] == responses[0].json()["id"]


@pytest.fixture
def scheduled():
    config = load_config()
    now = utc_now()
    window = Window(
        window_id="work", start=now - timedelta(minutes=5), end=now + timedelta(hours=5), free_units=10,
    )
    for point in ("A", "B", "C"):
        config.demo_routing.points[point] = PickupPoint(
            pvz_id=point, city_id="city", pack_minutes=10, load_minutes=5, receive_minutes=5,
            pack_windows=(window,), load_windows=(window,), receive_windows=(window,),
        )
    config.demo_routing.direct_trips = [DirectTrip(
        trip_id="A-B-1", source_id="A", pickup_pvz_id="B", departure_at=now + timedelta(hours=1),
        travel_minutes=30, loaded_orders=10, free_units=1, trip_kopecks=92000,
    )]
    return config


def test_closed_receiving_window_explains_hub(scheduled, tmp_path):
    schedule = scheduled.demo_routing
    schedule.points["B"] = schedule.points["B"].model_copy(update={"receive_windows": ()})
    with TestClient(create_app(str(tmp_path / "closed.sqlite3"), config=scheduled)) as client:
        register_points(client)
        receive(client)
        route = create(client)["route"]
        assert (route["route_type"], route["reason_code"]) == ("hub", "direct_windows_unavailable")
        planned = next(entry for entry in route["evaluations"] if entry["trip_id"] == "A-B-1")
        assert planned["reason_code"] == "direct_receive_window"


def test_concurrent_trip_capacity_and_release(scheduled, tmp_path):
    with TestClient(create_app(str(tmp_path / "trip.sqlite3"), config=scheduled)) as client:
        register_points(client)
        receive(client)
        with ThreadPoolExecutor(2) as pool:
            orders = list(pool.map(lambda _: create(client), range(2)))
        direct, hub = sorted(orders, key=lambda order: order["route"]["route_type"])
        assert direct["route"]["trip_id"] == "A-B-1"
        assert hub["route"]["route_type"] == "hub"
        assert any(row["reason_code"] == "direct_no_capacity" for row in hub["route"]["evaluations"])
        assert len(direct["route"]["milestones"]) == 5
        act(client, direct, "cancel", "A")
        assert create(client)["route"]["trip_id"] == "A-B-1"


def test_receive_window_is_shared_across_trips_and_released(scheduled, tmp_path):
    schedule = scheduled.demo_routing
    target = schedule.points["B"]
    schedule.points["B"] = target.model_copy(update={
        "receive_windows": (target.receive_windows[0].model_copy(update={"free_units": 1}),),
    })
    schedule.direct_trips.append(schedule.direct_trips[0].model_copy(update={
        "trip_id": "C-B-1", "source_id": "C",
    }))
    with TestClient(create_app(str(tmp_path / "window.sqlite3"), config=scheduled)) as client:
        register_points(client)
        receive(client)
        receive(client, "C", batch_id="lot-c")
        first = create(client)
        assert first["route"]["trip_id"] == "A-B-1"
        second = create(client)
        assert second["route"]["route_type"] == "hub"
        assert any(entry["reason_code"] == "direct_receive_window" for entry in second["route"]["evaluations"])
        replanned = act(client, first, "replan", "A", reason="окно погрузки сорвалось")
        assert replanned["route"]["trip_id"] == "C-B-1"
        assert replanned["route"]["replan_cause"] == "окно погрузки сорвалось"


def test_pending_inbound_reserves_physical_capacity(api):
    receive(api)
    receive(api, "B", 8, batch_id="filler", sku="OTHER")
    first = create(api)
    response = api.post("/api/orders", json=order_payload(wb_club=False))
    assert response.status_code == 409
    assert response.json()["detail"]["reason_code"] == "hub_no_stock"
    act(api, first, "cancel", "A")
    assert create(api, wb_club=False)["route"]["route_type"] == "hub"


def test_transit_uses_observation_and_keeps_cargo_in_transit(scheduled, tmp_path):
    with TestClient(create_app(str(tmp_path / "travel.sqlite3"), config=scheduled)) as client:
        register_points(client)
        receive(client)
        order = create(client)
        act(client, order, "pack", "A")
        act(client, order, "handoff", "A")
        lost = act(client, order, "update_transit", "A", actual_position="на трассе", remaining_travel_minutes=400)
        assert lost["route"]["reason_code"] == "receive_window_missing"
        assert lost["route"]["ready_at"] is None
        assert act(client, order, "receive", "B", 409)["detail"]["code"] == "route_window_unavailable"
        assert stock(client, "A")["in_transit"] == 1
        arrived = act(client, order, "update_transit", "A", actual_position="B", remaining_travel_minutes=0)
        route = arrived["route"]
        assert route["trip_id"] == "A-B-1" and route["meets_deadline"]
        assert route["arrival_at"] == arrived["operations"][-1]["details"]["arrival_at"]
        assert route["milestones"][-1]["stage"] == "receive"
        assert act(client, order, "receive", "B")["status"] == "ready"


def test_storage_and_issue_accrue_only_once(api):
    receive(api)
    storage_path = "/api/inventory/A/lot/storage"
    payload = {"request_id": "storage-today", "quantity": 3}
    confirmed = api.post(storage_path, json=payload)
    assert confirmed.status_code == 201
    assert api.post(storage_path, json=payload).json() == confirmed.json()
    duplicate = api.post(storage_path, json={**payload, "request_id": "storage-other-key"})
    assert duplicate.json()["detail"]["code"] == "storage_already_confirmed"
    ledger = api.get("/api/accruals", params={"point_id": "A", "batch_id": "lot"}).json()
    assert ledger["total_kopecks"] == 1200
    assert {item["reason"] for item in ledger["items"]} == {"intake", "storage"}

    order = create(api, "A")
    act(api, order, "pack", "A")
    act(api, order, "issue", "A", request_id="same-scan")
    replay = act(api, order, "issue", "A", request_id="same-scan")
    assert replay["accrual_total_kopecks"] == 3500
    assert len(api.get("/api/accruals", params={"order_id": order["id"]}).json()["items"]) == 2
    assert act(api, order, "issue", "A", 409)["detail"]["code"] == "invalid_order_status"
    assert stock(api, "A")["available"] == 2


def test_ledger_upgrades_existing_events_without_repricing(tmp_path):
    path = str(tmp_path / "existing.sqlite3")
    with TestClient(create_app(path)) as client:
        register_points(client)
        receive(client)
        order = create(client, "A")
        act(client, order, "pack", "A", request_id="stored-pack")
    engine = create_engine(f"sqlite:///{path}")
    with engine.begin() as connection:
        # V1 had the operation log and orders, but no ledger or route reservations.
        connection.execute(text("DROP TABLE logistics_accruals"))
        connection.execute(text("DROP TABLE route_reservations"))
        connection.execute(text(
            "UPDATE orders SET route = json_remove(route, '$.reason_code', '$.milestones', '$.evaluations')"
        ))
    engine.dispose()
    with TestClient(create_app(path)) as client:
        assert client.get("/api/accruals").json()["total_kopecks"] == 2400
        assert act(client, order, "pack", "A", request_id="stored-pack")["accrual_total_kopecks"] == 1500
        assert act(client, order, "issue", "A")["accrual_total_kopecks"] == 3500
    config = load_config()
    rate = config.logistics_pricing.operation_rates["issue"]
    config.logistics_pricing.operation_rates["issue"] = rate.model_copy(update={"per_unit_kopecks": 3000})
    with TestClient(create_app(path, config=config)) as client:
        assert client.get("/api/accruals").json()["total_kopecks"] == 4400


def test_accrual_and_stock_roll_back_together(api, monkeypatch):
    from backend.app.pricing import ledger

    receive(api)
    order = create(api, "A")
    act(api, order, "pack", "A")
    record = ledger.record_accrual

    def fail_after_insert(*args):
        record(*args)
        raise RuntimeError("test transaction failure")

    with monkeypatch.context() as patch:
        patch.setattr(ledger, "record_accrual", fail_after_insert)
        with pytest.raises(RuntimeError, match="test transaction failure"):
            act(api, order, "issue", "A", request_id="retry-issue")
    assert stock(api, "A")["ready"] == 1
    assert api.get(f"/api/orders/{order['id']}").json()["accrual_total_kopecks"] == 1500
    assert act(api, order, "issue", "A", request_id="retry-issue")["accrual_total_kopecks"] == 3500


def test_aged_stock_changes_routing_and_explains_cost(api):
    receive(api, days=40)
    order = create(api)
    route = order["route"]
    assert route["route_type"] == "hub"
    direct = next(item for item in route["evaluations"] if item["route_type"] == "direct")
    assert direct["quote"]["cost_breakdown"]["additional_kopecks"] == 10_800
    assert direct["quote"]["cost_kopecks"] == 27_000
    local = create(api, "A")["route"]
    assert (local["route_type"], local["reason_code"]) == ("hub", "shelf_more_expensive")


def test_district_comparison_and_risk_sensitivity(api):
    comparison = api.get("/api/analytics/comparison").json()
    assert comparison["selected_route"] == "direct"
    assert comparison["distribution"] == {"shelf": 10, "direct": 30, "hub": 60}
    assert comparison["baseline_kopecks"] == 1_720_000
    assert comparison["mesh_kopecks"] == 1_588_000
    assert comparison["savings_percent"] == 7.67
    low_load = api.get("/api/analytics/comparison", params={"trip_orders": 8}).json()
    assert (low_load["selected_route"], low_load["direct_kopecks"]) == ("hub", 18_500)
    risky = api.get("/api/analytics/comparison", params={"return_bps": 3000}).json()
    assert risky["selected_route"] == "hub"
    assert risky["expected_return_kopecks"] == 3600
    assert sum(risky["distribution"].values()) == comparison["cohort_orders"]


def test_dashboard_margins_and_return(api):
    receive(api)
    order = create(api)
    assert order["buyer_acceleration_fee_kopecks"] == 0
    for action, point in (("pack", "A"), ("handoff", "A"), ("receive", "B"), ("issue", "B")):
        act(api, order, action, point)
    assert api.get("/api/analytics/points/B", params={"order_id": order["id"]}).json() == {
        "revenue_kopecks": 2500, "costs_kopecks": 1500, "profit_kopecks": 1000,
    }
    report = api.get("/api/analytics/sellers/seller", params={"point_id": "B"}).json()
    assert len(report) == 1
    assert report[0]["storage_kopecks"] == 100
    assert report[0]["profit_kopecks"] == 10_650
    assert api.get("/api/analytics/sellers/seller", params={"point_id": "A"}).json() == []
    act(api, order, "return_good", "B")
    returned = api.get("/api/analytics/sellers/seller").json()[0]
    assert returned["revenue_kopecks"] == returned["goods_kopecks"] == 0
    assert returned["profit_kopecks"] == -7600

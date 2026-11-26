import json
from datetime import datetime, timedelta, timezone
from hashlib import sha256

from .config import PilotSchedule
from .contracts import (
    ResourceUsage, RouteDecision, RouteOption, RouteResource, RoutingRequest, TransitEstimate,
    TransitRequest,
)
from .pricing.costs import PilotPricing
from .routing import RouteRequest, choose_route, estimate_in_transit, recalculate_before_dispatch
from .routing.models import DirectTrip, HubQuote, InTransitUpdate, PickupPoint, RouteQuote, Stock, Window


class NoRoute(Exception):
    def __init__(self, reason: str, reason_code: str | None = None):
        super().__init__(reason)
        self.reason_code = reason_code


def resource_key(*parts: str) -> str:
    return json.dumps(parts, ensure_ascii=False, separators=(",", ":"))


def api_option(quote: RouteQuote) -> RouteOption:
    return RouteOption(
        route_type=quote.route_type.value,
        source_point_id=None if quote.route_type == "hub" else quote.source_id,
        ready_at=quote.ready_at,
        estimated_unit_cost_kopecks=quote.cost_kopecks,
    )


class PilotRouting:
    def __init__(self, schedule: PilotSchedule, pricing: PilotPricing):
        self.schedule = schedule
        self.pricing = pricing

    def city_id(self, point_id: str) -> str:
        point = self.schedule.points.get(point_id)
        return point.city_id if point else "pilot-city"

    def point(
        self, point_id: str, start: datetime, usage: dict[str, ResourceUsage],
        *, receiving_capacity: int | None = None,
    ) -> tuple[PickupPoint, dict[tuple[str, str, str], RouteResource]]:
        plan = self.schedule
        point = plan.points.get(point_id)
        if point is None:
            midnight = start.astimezone(timezone.utc).replace(hour=0, minute=0, second=0, microsecond=0)
            windows = tuple(
                Window(
                    start=midnight + timedelta(days=offset), end=midnight + timedelta(days=offset + 1),
                    free_units=plan.window_capacity_units,
                )
                for offset in range(3)
            )
            point = PickupPoint(
                pvz_id=point_id, city_id=self.city_id(point_id), pack_minutes=plan.shelf_minutes,
                load_minutes=plan.load_minutes, receive_minutes=plan.receive_minutes,
                pack_windows=windows, load_windows=windows, receive_windows=windows,
            )
        reservations = {}
        windows_by_stage = {}
        for stage in ("pack", "load", "receive"):
            available = []
            for window in getattr(point, f"{stage}_windows"):
                if window.end <= start:
                    continue
                window_id = window.window_id or resource_key(window.start.isoformat(), window.end.isoformat())
                key = resource_key(stage, point_id, window_id, window.start.isoformat())
                used = usage.get(key)
                free = window.free_units - (used.quantity if used else 0)
                if stage == "receive" and receiving_capacity is not None:
                    free = min(free, receiving_capacity)
                available.append(window.model_copy(update={"free_units": max(0, free), "window_id": window_id}))
                reservations[(point_id, stage, window_id)] = RouteResource(
                    key=key, stage=stage, expires_at=window.end,
                )
            windows_by_stage[f"{stage}_windows"] = tuple(available)
        return point.model_copy(update=windows_by_stage), reservations

    def pilot_trip(self, request: RoutingRequest, source: PickupPoint) -> DirectTrip:
        plan = self.schedule
        now = request.requested_at.astimezone(timezone.utc)
        packed_at = now + timedelta(minutes=source.pack_minutes)
        midnight = now.replace(hour=0, minute=0, second=0, microsecond=0) + timedelta(days=1)
        if source.pvz_id not in plan.points and packed_at > midnight:
            packed_at = midnight + timedelta(minutes=source.pack_minutes)
        earliest = packed_at + timedelta(minutes=source.load_minutes)
        if source.pvz_id not in plan.points and packed_at < midnight < earliest:
            earliest = midnight + timedelta(minutes=source.load_minutes)
        interval = plan.departure_interval_minutes * 60
        departure = datetime.fromtimestamp((int(earliest.timestamp()) // interval + 1) * interval, timezone.utc)
        key = resource_key(source.pvz_id, request.pickup_point_id, departure.isoformat())
        trip_id = "pilot-" + sha256(key.encode()).hexdigest()[:24]
        return DirectTrip(
            trip_id=trip_id, source_id=source.pvz_id, pickup_pvz_id=request.pickup_point_id,
            departure_at=departure, travel_minutes=plan.travel_minutes, loaded_orders=plan.trip_orders,
            free_units=plan.trip_capacity_units, trip_kopecks=plan.direct_trip_kopecks,
            retained_hub_kopecks=plan.retained_hub_unit_kopecks,
        )

    def trips(
        self, request: RoutingRequest, points: dict[str, PickupPoint],
    ) -> tuple[list[DirectTrip], dict[str, RouteResource]]:
        generated = self.schedule.direct_trips is None
        configured = (
            [self.pilot_trip(request, points[item.point_id]) for item in request.stock
             if item.point_id != request.pickup_point_id and item.available >= request.quantity]
            if generated else self.schedule.direct_trips
        )
        trips, reservations = [], {}
        for trip in configured:
            if trip.source_id not in points or trip.pickup_pvz_id != request.pickup_point_id:
                continue
            key = resource_key("departure", trip.trip_id, trip.departure_at.isoformat())
            used = request.resource_usage.get(key, ResourceUsage())
            indices = set(used.order_indices)
            position = trip.order_index
            while position in indices:
                position += 1
            free = max(0, trip.free_units - used.quantity) if position < trip.loaded_orders else 0
            delay = trip.individual_idle_kopecks
            if generated:
                share, remainder = divmod(self.schedule.direct_total_individual_delay_kopecks, trip.loaded_orders)
                delay = share + int(position < remainder)
            trips.append(trip.model_copy(update={
                "free_units": free, "order_index": min(position, trip.loaded_orders - 1),
                "individual_idle_kopecks": delay,
            }))
            reservations[trip.trip_id] = RouteResource(
                key=key, stage="departure", expires_at=trip.departure_at, order_index=position,
            )
        return trips, reservations

    def choose(self, request: RoutingRequest) -> RouteDecision:
        pickup = request.pickup_point_id
        free_units = request.pickup_free_volume_cm3 // request.unit_volume_cm3
        shelf_only = request.fulfillment == "shelf_today"
        stock = [item for item in request.stock if not shelf_only or item.point_id == pickup]
        points, window_resources = {}, {}
        for point_id in [pickup, *(item.point_id for item in stock if item.point_id != pickup)]:
            points[point_id], resources = self.point(
                point_id, request.requested_at, request.resource_usage,
                receiving_capacity=free_units if point_id == pickup else None,
            )
            window_resources.update(resources)
        trips, trip_resources = ([], {}) if shelf_only else self.trips(request, points)
        hub_minutes = self.schedule.hub_minutes
        hub = (
            HubQuote(source_id="HUB-1", ready_at=request.requested_at + timedelta(minutes=hub_minutes),
                     available=free_units)
            if hub_minutes is not None and not shelf_only else None
        )
        snapshot = RouteRequest(
            product_id=request.sku, quantity=request.quantity, wb_club=request.wb_club,
            pickup_pvz_id=pickup, now=request.requested_at, deadline=request.promised_by,
            pickup_points=tuple(points.values()), direct_trips=tuple(trips), hub=hub,
            stock=tuple(Stock(
                product_id=request.sku, pvz_id=row.point_id, available=row.available,
                extra_storage_kopecks=row.extra_storage_kopecks,
            )
                        for row in stock),
        )
        if request.replan_cause:
            decision = recalculate_before_dispatch(
                snapshot, self.pricing, failure=request.replan_cause,
                excluded_source_ids=frozenset(request.excluded_source_ids),
                excluded_trip_ids=frozenset(request.excluded_trip_ids),
                fulfillment=request.fulfillment,
            )
        else:
            decision = choose_route(snapshot, self.pricing, fulfillment=request.fulfillment)
        selected = decision.selected_option
        if selected is None:
            raise NoRoute(decision.reason, decision.reason_code)
        chosen = api_option(selected)
        resources = [
            window_resources[(step.pvz_id, step.stage, step.window_id)]
            for step in selected.milestones if step.window_id is not None
        ]
        if decision.trip_id is not None:
            resources.append(trip_resources[decision.trip_id])
        options = [api_option(candidate.quote) for candidate in decision.evaluations if candidate.quote]
        arrival = next((step.ends_at for step in selected.milestones if step.stage == "arrival"), None)
        return RouteDecision(
            **chosen.model_dump(), pickup_point_id=pickup, reason=decision.reason,
            reason_code=decision.reason_code, trip_id=decision.trip_id,
            hub_source_id=decision.hub_option.source_id if decision.hub_option else None,
            alternatives=options, cost_breakdown=selected.cost_breakdown, milestones=selected.milestones,
            evaluations=decision.evaluations, replan_cause=decision.replan_cause, resources=resources,
            arrival_at=arrival, meets_deadline=True,
        )

    def estimate_transit(self, request: TransitRequest) -> TransitEstimate:
        arrival = request.observed_at + timedelta(minutes=request.remaining_travel_minutes)
        pickup, resources = self.point(
            request.pickup_point_id, arrival, request.resource_usage, receiving_capacity=request.pickup_free_units,
        )
        result = estimate_in_transit(InTransitUpdate(
            current_location_id=request.actual_position, observed_at=request.observed_at,
            remaining_travel_minutes=request.remaining_travel_minutes, quantity=request.quantity,
            pickup_point=pickup, deadline=request.promised_by,
        ))
        slot = result.receiving_slot
        return TransitEstimate(
            ready_at=result.ready_at, arrival_at=result.arrival_at, meets_deadline=result.meets_deadline,
            reason=result.reason, reason_code=result.reason_code, receiving_slot=slot,
            resource=resources[(slot.pvz_id, slot.stage, slot.window_id)] if slot else None,
        )

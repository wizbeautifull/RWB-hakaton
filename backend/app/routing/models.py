"""Контракт между сервисом заказов и модулем маршрутизации."""

from datetime import UTC, datetime
from enum import StrEnum
from typing import Annotated, Literal

from pydantic import AfterValidator, AwareDatetime, Field, StrictBool, model_validator

from ..pricing.costs import Contract, CostBreakdown, Count, Identifier, Money

Units = Annotated[int, Field(strict=True, ge=0)]
Duration = Annotated[int, Field(strict=True, gt=0, le=525_600)]
Stage = Literal["pack", "load", "departure", "arrival", "receive", "hub_ready"]
Fulfillment = Literal["delivery", "shelf_today"]


def _utc(value: datetime) -> datetime:
    return value.astimezone(UTC)


# Единая шкала времени позволяет корректно сравнивать окна с разными смещениями.
Instant = Annotated[AwareDatetime, AfterValidator(_utc)]


class RouteType(StrEnum):
    SHELF = "shelf"
    DIRECT = "direct"
    HUB = "hub"
    UNAVAILABLE = "unavailable"


class Window(Contract):
    start: Instant
    end: Instant
    free_units: Units
    window_id: Identifier | None = None

    @model_validator(mode="after")
    def validate_bounds(self):
        if self.start >= self.end:
            raise ValueError("Window end must be after start")
        return self


class PickupPoint(Contract):
    pvz_id: Identifier
    city_id: Identifier
    pack_minutes: Duration
    load_minutes: Duration
    receive_minutes: Duration
    pack_windows: tuple[Window, ...] = ()
    load_windows: tuple[Window, ...] = ()
    receive_windows: tuple[Window, ...] = ()

    @model_validator(mode="after")
    def validate_window_ids(self):
        for windows in (self.pack_windows, self.load_windows, self.receive_windows):
            ids = [window.window_id for window in windows if window.window_id is not None]
            if len(ids) != len(set(ids)):
                raise ValueError("Duplicate window_id within a pickup point and operation")
        return self


class Stock(Contract):
    product_id: Identifier
    pvz_id: Identifier
    available: Units
    extra_storage_kopecks: Money = 0


class DirectTrip(Contract):
    trip_id: Identifier
    source_id: Identifier
    pickup_pvz_id: Identifier
    departure_at: Instant
    travel_minutes: Duration
    loaded_orders: Count
    order_index: Units = 0
    free_units: Units
    trip_kopecks: Money
    stops_kopecks: Money = 0
    shared_idle_kopecks: Money = 0
    empty_mileage_kopecks: Money = 0
    individual_idle_kopecks: Money = 0
    retained_hub_kopecks: Money = 0

    @model_validator(mode="after")
    def validate_trip(self):
        if self.source_id == self.pickup_pvz_id:
            raise ValueError("Direct trip requires two different pickup points")
        if self.order_index >= self.loaded_orders:
            raise ValueError("order_index must be less than loaded_orders")
        return self


class HubQuote(Contract):
    source_id: Identifier
    ready_at: Instant
    available: Units
    additional_kopecks: Money = 0


class RouteRequest(Contract):
    product_id: Identifier
    quantity: Count
    wb_club: StrictBool
    pickup_pvz_id: Identifier
    now: Instant
    deadline: Instant
    pickup_points: tuple[PickupPoint, ...]
    stock: tuple[Stock, ...] = ()
    direct_trips: tuple[DirectTrip, ...] = ()
    hub: HubQuote | None = None

    @model_validator(mode="after")
    def validate_snapshot(self):
        point_ids = {point.pvz_id for point in self.pickup_points}
        stock_keys = {(item.pvz_id, item.product_id) for item in self.stock}
        trip_ids = {trip.trip_id for trip in self.direct_trips}
        if (
            len(point_ids) != len(self.pickup_points)
            or len(stock_keys) != len(self.stock)
            or len(trip_ids) != len(self.direct_trips)
        ):
            raise ValueError("Snapshot contains duplicate pickup points, stock rows or trips")
        if self.pickup_pvz_id not in point_ids:
            raise ValueError("Selected pickup point is missing")
        if any(item.pvz_id not in point_ids for item in self.stock):
            raise ValueError("Stock references an unknown pickup point")
        if any(
            trip.source_id not in point_ids or trip.pickup_pvz_id not in point_ids
            for trip in self.direct_trips
        ):
            raise ValueError("Trip references an unknown pickup point")
        return self


class RouteMilestone(Contract):
    stage: Stage
    starts_at: Instant
    ends_at: Instant
    pvz_id: Identifier | None = None
    window_id: Identifier | None = None


class RouteQuote(Contract):
    route_type: RouteType
    source_id: Identifier
    ready_at: Instant
    cost_kopecks: Money
    trip_id: Identifier | None = None
    cost_breakdown: CostBreakdown | None = None
    milestones: tuple[RouteMilestone, ...] = ()


class CandidateEvaluation(Contract):
    route_type: RouteType
    source_id: Identifier | None = None
    trip_id: Identifier | None = None
    status: Literal["selected", "eligible", "rejected", "skipped"]
    reason_code: str
    reason: str
    quote: RouteQuote | None = None
    milestones: tuple[RouteMilestone, ...] = ()


class RouteDecision(Contract):
    route_type: RouteType
    pickup_pvz_id: Identifier
    source_id: Identifier | None = None
    ready_at: Instant | None = None
    cost_kopecks: Money | None = None
    trip_id: Identifier | None = None
    reason_code: str
    reason: str
    direct_option: RouteQuote | None = None
    hub_option: RouteQuote | None = None
    selected_option: RouteQuote | None = None
    evaluations: tuple[CandidateEvaluation, ...] = ()
    replan_cause: str | None = None


class InTransitUpdate(Contract):
    current_location_id: Identifier
    observed_at: Instant
    remaining_travel_minutes: Annotated[int, Field(strict=True, ge=0, le=525_600)]
    quantity: Count
    pickup_point: PickupPoint
    deadline: Instant


class TransitEstimate(Contract):
    current_location_id: Identifier
    pickup_pvz_id: Identifier
    arrival_at: Instant
    ready_at: Instant | None
    meets_deadline: bool
    reason_code: str
    reason: str
    receiving_slot: RouteMilestone | None = None

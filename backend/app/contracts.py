from datetime import datetime, timezone
from typing import Annotated, Literal

from pydantic import AwareDatetime, BaseModel, ConfigDict, Field, StringConstraints

from .pricing.costs import CostBreakdown
from .routing.models import CandidateEvaluation, RouteMilestone

Code = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=80)]
Quantity = Annotated[int, Field(gt=0, le=1_000_000, strict=True)]
Volume = Annotated[int, Field(gt=0, le=1_000_000_000, strict=True)]
RouteType = Literal["shelf", "direct", "hub"]
OrderStatus = Literal[
    "reserved", "packed", "in_transit", "awaiting_hub", "ready",
    "delivered", "cancelled", "awaiting_route", "returned",
]
Action = Literal[
    "pack", "handoff", "receive", "confirm_hub_delivery", "issue", "cancel",
    "shortage", "replan", "update_transit", "return_good", "return_damaged",
]


def utc_now() -> datetime:
    return datetime.now(timezone.utc)


class APIModel(BaseModel):
    model_config = ConfigDict(extra="forbid", from_attributes=True)


class Command(APIModel):
    request_id: Code


class OrderRequest(Command):
    sku: Code
    quantity: Quantity = 1
    wb_club: bool
    pickup_point_id: Code
    promised_by: AwareDatetime


class RoutingStock(APIModel):
    point_id: Code
    available: int
    extra_storage_kopecks: int = 0


class ResourceUsage(APIModel):
    quantity: int = 0
    order_indices: list[int] = Field(default_factory=list)


class RouteResource(APIModel):
    key: str
    stage: Literal["pack", "load", "departure", "receive"]
    expires_at: AwareDatetime
    order_index: int | None = None


class RoutingRequest(APIModel):
    sku: Code
    quantity: Quantity
    unit_volume_cm3: Volume
    wb_club: bool
    pickup_point_id: Code
    pickup_free_volume_cm3: int
    promised_by: AwareDatetime
    requested_at: AwareDatetime
    stock: list[RoutingStock]
    excluded_source_ids: list[Code] = Field(default_factory=list)
    excluded_trip_ids: list[str] = Field(default_factory=list)
    replan_cause: str | None = None
    resource_usage: dict[str, ResourceUsage] = Field(default_factory=dict)


class RouteOption(APIModel):
    route_type: RouteType
    source_point_id: Code | None
    ready_at: AwareDatetime
    estimated_unit_cost_kopecks: int = Field(ge=0)


class RouteDecision(RouteOption):
    ready_at: AwareDatetime | None
    pickup_point_id: Code
    reason: str
    alternatives: list[RouteOption] = Field(default_factory=list)
    reason_code: str | None = None
    trip_id: str | None = None
    hub_source_id: str | None = None
    cost_breakdown: CostBreakdown | None = None
    milestones: tuple[RouteMilestone, ...] = ()
    evaluations: tuple[CandidateEvaluation, ...] = ()
    replan_cause: str | None = None
    arrival_at: AwareDatetime | None = None
    meets_deadline: bool | None = None
    resources: list[RouteResource] = Field(default_factory=list, exclude=True)


class TransitRequest(APIModel):
    order_id: Code
    pickup_point_id: Code
    actual_position: Code
    observed_at: AwareDatetime
    promised_by: AwareDatetime
    quantity: Quantity
    pickup_free_units: int
    remaining_travel_minutes: int
    resource_usage: dict[str, ResourceUsage]


class TransitEstimate(APIModel):
    ready_at: AwareDatetime | None
    arrival_at: AwareDatetime
    meets_deadline: bool
    reason: str
    reason_code: str
    receiving_slot: RouteMilestone | None
    resource: RouteResource | None = None


class OperationEvent(APIModel):
    event_id: Code
    type: str
    point_id: Code
    occurred_at: AwareDatetime
    quantity: Quantity
    order_id: Code | None = None
    batch_id: Code | None = None
    sku: Code
    details: dict = Field(default_factory=dict)


class Accrual(APIModel):
    event_id: Code
    point_id: Code
    amount_kopecks: int
    reason: str
    payer_id: str
    recipient_id: str
    unit_rate_kopecks: int
    quantity: int

import json
import os
from pathlib import Path

from pydantic import BaseModel, Field, model_validator

from .economics import EconomicsConfig
from .pricing.costs import PilotPricing
from .routing.models import DirectTrip, PickupPoint

ROOT = Path(__file__).resolve().parents[2]


class PilotSchedule(BaseModel):
    direct_trip_kopecks: int = Field(ge=0)
    direct_total_individual_delay_kopecks: int = Field(ge=0)
    retained_hub_unit_kopecks: int = Field(ge=0)
    trip_orders: int = Field(gt=0, le=1_000_000)
    trip_capacity_units: int = Field(default=100, gt=0)
    window_capacity_units: int = Field(default=100, gt=0)
    shelf_minutes: int = Field(gt=0, lt=1440)
    load_minutes: int = Field(default=10, gt=0, lt=1440)
    receive_minutes: int = Field(default=10, gt=0, lt=1440)
    direct_minutes: int = Field(gt=0, le=525_600)
    hub_minutes: int | None = Field(gt=0, le=525_600)
    departure_interval_minutes: int = Field(default=30, gt=0, le=1440)
    points: dict[str, PickupPoint] = Field(default_factory=dict)
    # None enables the pilot timetable. An explicit empty list means no trips.
    direct_trips: list[DirectTrip] | None = None

    @model_validator(mode="after")
    def validate_schedule(self):
        if self.direct_minutes <= self.shelf_minutes + self.load_minutes + self.receive_minutes:
            raise ValueError("direct_minutes must include a positive travel duration")
        if any(key != point.pvz_id for key, point in self.points.items()):
            raise ValueError("Schedule point key must match pvz_id")
        if self.direct_trips is not None:
            ids = [trip.trip_id for trip in self.direct_trips]
            if len(ids) != len(set(ids)):
                raise ValueError("Duplicate scheduled trip ID")
        return self

    @property
    def travel_minutes(self) -> int:
        return self.direct_minutes - self.shelf_minutes - self.load_minutes - self.receive_minutes


class PilotConfig(BaseModel):
    capacity_reserve_percent: int = Field(ge=0, lt=100)
    slow_stock_days: int = Field(gt=0)
    demo_routing: PilotSchedule
    logistics_pricing: PilotPricing
    economics: EconomicsConfig = Field(default_factory=EconomicsConfig)


def load_config() -> PilotConfig:
    default_path = ROOT / "config" / "pilot.json"
    path = Path(os.environ.get("MESH_PILOT_CONFIG", default_path))
    data = json.loads(path.read_text(encoding="utf-8-sig"))
    if "logistics_pricing" not in data and path != default_path:
        rates = json.loads(default_path.read_text(encoding="utf-8-sig"))["logistics_pricing"]
        for old_key, new_key in (
            ("shelf_unit_kopecks", "shelf_per_order_kopecks"),
            ("direct_base_unit_kopecks", "direct_per_order_kopecks"),
            ("hub_unit_kopecks", "hub_per_order_kopecks"),
        ):
            if old_key in data["demo_routing"]:
                rates[new_key] = data["demo_routing"][old_key]
        data["logistics_pricing"] = rates
    return PilotConfig.model_validate(data)

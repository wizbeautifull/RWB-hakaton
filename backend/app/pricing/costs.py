"""Себестоимость маршрута и ставки по подтверждённым операциям."""

import json
from pathlib import Path
from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field, StringConstraints

Money = Annotated[int, Field(strict=True, ge=0)]
Count = Annotated[int, Field(strict=True, gt=0)]
Identifier = Annotated[str, StringConstraints(strict=True, strip_whitespace=True, min_length=1)]
OperationType = Literal["intake", "storage", "pack", "handover", "transfer_receive", "issue", "return"]


class Contract(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)


class OperationRate(Contract):
    payer_id: Identifier
    recipient_id: Identifier = "$pvz"
    per_unit_kopecks: Money


class PilotPricing(Contract):
    shelf_per_order_kopecks: Money
    direct_per_order_kopecks: Money
    hub_per_order_kopecks: Money
    operation_rates: dict[OperationType, OperationRate]
    allow_direct_without_eligible_hub: Annotated[bool, Field(strict=True)] = True


class CostBreakdown(Contract):
    base_kopecks: Money
    trip_share_kopecks: Money = 0
    individual_idle_kopecks: Money = 0
    retained_hub_kopecks: Money = 0
    additional_kopecks: Money = 0

    @property
    def total_kopecks(self) -> int:
        return (
            self.base_kopecks
            + self.trip_share_kopecks
            + self.individual_idle_kopecks
            + self.retained_hub_kopecks
            + self.additional_kopecks
        )


def load_pricing(path: str | Path) -> PilotPricing:
    """Читает секцию логистики из общего конфига команды."""
    data = json.loads(Path(path).read_text(encoding="utf-8-sig"))
    return PilotPricing.model_validate(data["logistics_pricing"])


def direct_breakdown(
    pricing: PilotPricing,
    *,
    loaded_orders: int,
    order_index: int,
    trip: int,
    stops: int,
    shared_idle: int,
    empty_mileage: int,
    individual_idle: int,
    retained_hub: int,
    additional_kopecks: int = 0,
) -> CostBreakdown:
    if not 0 <= order_index < loaded_orders:
        raise ValueError("order_index must be within the loaded trip")
    # Остаток от деления распределяется так, чтобы сумма долей совпала с ценой рейса.
    share, remainder = divmod(trip + stops + shared_idle + empty_mileage, loaded_orders)
    return CostBreakdown(
        base_kopecks=pricing.direct_per_order_kopecks,
        trip_share_kopecks=share + int(order_index < remainder),
        individual_idle_kopecks=individual_idle,
        retained_hub_kopecks=retained_hub,
        additional_kopecks=additional_kopecks,
    )


def direct_cost(
    pricing: PilotPricing,
    *,
    loaded_orders: int,
    order_index: int,
    trip: int,
    stops: int,
    shared_idle: int,
    empty_mileage: int,
    individual_idle: int,
    retained_hub: int,
) -> int:
    return direct_breakdown(
        pricing,
        loaded_orders=loaded_orders,
        order_index=order_index,
        trip=trip,
        stops=stops,
        shared_idle=shared_idle,
        empty_mileage=empty_mileage,
        individual_idle=individual_idle,
        retained_hub=retained_hub,
    ).total_kopecks

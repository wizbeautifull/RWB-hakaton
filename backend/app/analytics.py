from datetime import datetime
from typing import Annotated, Literal

from fastapi import APIRouter, Query
from pydantic import BaseModel
from sqlalchemy import select

from .config import PilotConfig
from .contracts import Code
from .db import Database
from .economics import EconomicsConfig, rate_amount
from .inventory.service import get_point
from .models import Allocation, Batch, Order, Product
from .operations import read_events
from .pricing.ledger import PricingLedger


class Comparison(BaseModel):
    trip_orders: int
    direct_kopecks: int
    shelf_kopecks: int
    hub_kopecks: int
    direct_storage_extra_kopecks: int
    expected_return_kopecks: int
    selected_route: Literal["direct", "hub"]
    cohort_orders: int
    baseline_kopecks: int
    mesh_kopecks: int
    savings_kopecks: int
    savings_percent: float
    distribution: dict[str, int]


def compare_cohort(pilot: PilotConfig, load: int, storage_days: int, return_bps: int) -> Comparison:
    schedule = pilot.demo_routing
    pricing = pilot.logistics_pricing
    economy = pilot.economics
    expected_return = rate_amount(economy.marketplace_return_kopecks, return_bps)
    reference_return = rate_amount(economy.marketplace_return_kopecks, economy.return_probability_bps)
    extra_storage = economy.excess_storage(storage_days)
    trip_total = schedule.direct_trip_kopecks + schedule.direct_total_individual_delay_kopecks
    trip_share = (2 * trip_total + load) // (2 * load)
    direct = pricing.direct_per_order_kopecks + trip_share + schedule.retained_hub_unit_kopecks + extra_storage
    direct = max(0, direct + expected_return - reference_return)
    shelf = max(0, pricing.shelf_per_order_kopecks + extra_storage + expected_return - reference_return)
    hub = pricing.hub_per_order_kopecks
    shelf_orders = 10 if shelf <= hub else 0
    direct_orders = 30 if direct < hub else 0
    hub_orders = 100 - shelf_orders - direct_orders
    baseline = 100 * hub
    mesh = shelf_orders * shelf + direct_orders * direct + hub_orders * hub
    savings = baseline - mesh
    return Comparison(
        trip_orders=load, direct_kopecks=direct, shelf_kopecks=shelf, hub_kopecks=hub,
        direct_storage_extra_kopecks=extra_storage, expected_return_kopecks=expected_return,
        selected_route="direct" if direct_orders else "hub", cohort_orders=100, baseline_kopecks=baseline,
        mesh_kopecks=mesh, savings_kopecks=savings,
        savings_percent=round(100 * savings / baseline, 2) if baseline else 0,
        distribution={"shelf": shelf_orders, "direct": direct_orders, "hub": hub_orders},
    )


class PointMargin(BaseModel):
    revenue_kopecks: int
    costs_kopecks: int
    profit_kopecks: int


class SellerMargin(BaseModel):
    order_id: Code
    sku: Code
    status: str
    point_id: Code
    revenue_kopecks: int
    goods_kopecks: int
    commission_kopecks: int
    logistics_kopecks: int
    storage_kopecks: int
    return_kopecks: int
    profit_kopecks: int


def seller_profit(
    order: Order, batches: list[tuple[Batch, int]], economy: EconomicsConfig, damaged_return: bool,
) -> SellerMargin:
    terms = economy.seller_by_sku.get(order.sku, economy.seller_default)
    quantity = order.quantity
    kind = order.route["route_type"]
    ordered_at = datetime.fromisoformat(order.created_at)
    storage_days = sum(
        quantity * max(0, (ordered_at - datetime.fromisoformat(batch.delivered_at)).days)
        for batch, quantity in batches if not batch.simulated
    )
    returned = order.status == "returned"
    revenue = 0 if returned else terms.sale_kopecks * quantity
    goods = terms.goods_kopecks * quantity if not returned or damaged_return else 0
    commission = rate_amount(revenue, terms.commission_bps)
    logistics = {
        "shelf": terms.shelf_logistics_kopecks,
        "direct": terms.direct_logistics_kopecks,
        "hub": terms.hub_logistics_kopecks,
    }[kind]
    storage = storage_days * terms.storage_unit_day_kopecks
    returns = terms.return_unit_kopecks * quantity
    if not returned:
        returns = rate_amount(returns, economy.return_probability_bps)
    return SellerMargin(
        order_id=order.id, sku=order.sku, status=order.status, point_id=order.pickup_point_id,
        revenue_kopecks=revenue, goods_kopecks=goods, commission_kopecks=commission,
        logistics_kopecks=logistics, storage_kopecks=storage, return_kopecks=returns,
        profit_kopecks=revenue - goods - commission - logistics - storage - returns,
    )


def analytics_router(db: Database, pilot: PilotConfig, ledger: PricingLedger) -> APIRouter:
    router = APIRouter(prefix="/api/analytics", tags=["Экономика"])

    @router.get("/comparison")
    def comparison(
        trip_orders: Annotated[int | None, Query(ge=1, le=1_000_000)] = None,
        storage_days: Annotated[int | None, Query(ge=0, le=3650)] = None,
        return_bps: Annotated[int | None, Query(ge=0, le=10_000)] = None,
    ) -> Comparison:
        return compare_cohort(
            pilot, pilot.demo_routing.trip_orders if trip_orders is None else trip_orders,
            pilot.economics.included_storage_days if storage_days is None else storage_days,
            pilot.economics.return_probability_bps if return_bps is None else return_bps,
        )

    @router.get("/points/{point_id}")
    def point_margin(point_id: Code, order_id: Code | None = None) -> PointMargin:
        with db.transaction() as session:
            get_point(session, point_id)
            items = [item for item in ledger.list(session, point_id=point_id, order_id=order_id)
                     if item.recipient_id == point_id]
            revenues = sum(item.amount_kopecks for item in items)
            rates = pilot.economics.point_operation_costs_kopecks
            costs = sum(rates.get(item.reason, 0) * item.quantity for item in items)
            return PointMargin(revenue_kopecks=revenues, costs_kopecks=costs, profit_kopecks=revenues - costs)

    @router.get("/sellers/{seller_id}")
    def seller_margin(seller_id: Code, point_id: Code | None = None) -> list[SellerMargin]:
        with db.transaction() as session:
            query = (
                select(Order).join_from(Order, Product, Order.sku == Product.sku)
                .where(Product.seller_id == seller_id, Order.status.not_in(("cancelled", "awaiting_route")))
                .order_by(Order.created_at.desc(), Order.id)
            )
            if point_id is not None:
                get_point(session, point_id)
                query = query.where(Order.pickup_point_id == point_id)
            result = []
            for order in session.scalars(query):
                batches = session.execute(
                    select(Batch, Allocation.quantity).join_from(Allocation, Batch)
                    .where(Allocation.order_id == order.id)
                ).all()
                damaged = order.status == "returned" and any(
                    event.type == "return_damaged" for event in read_events(session, order_id=order.id)
                )
                result.append(seller_profit(order, batches, pilot.economics, damaged))
            return result

    return router

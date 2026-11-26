from datetime import datetime
from math import ceil
from uuid import uuid4

from pydantic import AwareDatetime, Field
from sqlalchemy import func, or_, select
from sqlalchemy.orm import Session

from ..config import PilotConfig
from ..contracts import (
    APIModel, Accrual, Action, Code, Command, OperationEvent, OrderRequest, OrderStatus,
    Quantity, RouteDecision, RoutingRequest, RoutingStock, TransitRequest, utc_now,
)
from ..db import Database
from ..integrations import NoRoute, PilotRouting
from ..inventory.service import get_point, get_product, point_view, require_space, stock_at
from ..models import Allocation, Batch, Order, Product, Stock
from ..operations import OperationLog, read_events, reject
from ..pricing.ledger import PricingLedger
from ..routing.models import RouteMilestone
from . import reservations


class OrderCommand(Command):
    type: Action
    point_id: Code
    scan_code: Code
    shortage_quantity: Quantity | None = None
    shortage_batch_id: Code | None = None
    reason: Code | None = None
    actual_position: Code | None = None
    remaining_travel_minutes: int | None = Field(default=None, ge=0, le=525_600, strict=True)


class NextAction(APIModel):
    type: Action
    point_id: Code


class BatchAllocation(APIModel):
    batch_id: Code
    quantity: Quantity


class OrderView(APIModel):
    id: Code
    scan_code: Code
    sku: Code
    quantity: Quantity
    wb_club: bool
    pickup_point_id: Code
    source_point_id: Code | None
    promised_by: AwareDatetime
    created_at: AwareDatetime
    status: OrderStatus
    actual_position: Code | None
    route: RouteDecision | None
    route_failure: str | None
    next_actions: list[NextAction]
    allocations: list[BatchAllocation]
    operations: list[OperationEvent]
    accruals: list[Accrual]
    accrual_total_kopecks: int
    pricing_pending: bool
    buyer_acceleration_fee_kopecks: int


def get_order(session: Session, order_id: str) -> Order:
    order = session.get(Order, order_id)
    if order is None:
        reject("order_not_found", "Заказ не найден", 404)
    return order


def action_points(order: Order) -> dict[Action, str]:
    source = order.source_point_id
    pickup = order.pickup_point_id
    actions = {
        "reserved": {"pack": source, "cancel": source, "shortage": source, "replan": source},
        "packed": {"handoff": source, "cancel": source, "shortage": source, "replan": source},
        "in_transit": {"receive": pickup, "update_transit": source},
        "awaiting_hub": {"confirm_hub_delivery": pickup, "cancel": pickup, "replan": pickup},
        "awaiting_route": {"replan": pickup, "cancel": pickup},
        "ready": {"issue": pickup},
        "delivered": {"return_good": pickup, "return_damaged": pickup},
    }.get(order.status, {})
    if order.status == "ready" and order.route["route_type"] == "shelf":
        actions.update(cancel=pickup, shortage=pickup, replan=pickup)
    return actions


class Orders:
    def __init__(
        self, db: Database, pilot: PilotConfig, routing: PilotRouting, ledger: PricingLedger,
    ):
        self.db = db
        self.reserve_percent = pilot.capacity_reserve_percent
        self.economics = pilot.economics
        self.routing = routing
        self.ledger = ledger

    def view(self, session: Session, order: Order) -> OrderView:
        events = read_events(session, order_id=order.id)
        accruals = self.ledger.list(session, order_id=order.id)
        return OrderView(
            id=order.id, scan_code=order.scan_code, sku=order.sku, quantity=order.quantity,
            wb_club=order.wb_club, pickup_point_id=order.pickup_point_id,
            source_point_id=order.source_point_id, promised_by=order.promised_by,
            created_at=order.created_at, status=order.status, route=order.route,
            route_failure=order.route_failure, actual_position=order.actual_position,
            next_actions=[NextAction(type=kind, point_id=point) for kind, point in action_points(order).items()],
            allocations=[BatchAllocation.model_validate(item) for item in self.allocations(session, order)],
            operations=events, accruals=accruals, pricing_pending=False,
            accrual_total_kopecks=sum(entry.amount_kopecks for entry in accruals),
            buyer_acceleration_fee_kopecks=(
                self.economics.buyer_acceleration_fee_kopecks
                if order.route and order.route["route_type"] != "hub" else 0
            ),
        )

    def routing_request(
        self, session: Session, order: Order,
    ) -> RoutingRequest:
        pickup = get_point(session, order.pickup_point_id)
        product = get_product(session, order.sku)
        batches = session.execute(
            select(Stock, Batch)
            .join_from(Stock, Batch).where(Batch.sku == order.sku, Stock.available > 0)
            .order_by(Stock.point_id, Batch.delivered_at, Batch.id)
        )
        now = utc_now()
        balances: dict[str, RoutingStock] = {}
        for stock, batch in batches:
            balance = balances.setdefault(stock.point_id, RoutingStock(point_id=stock.point_id, available=0))
            units = min(stock.available, max(0, order.quantity - balance.available))
            days = (now - datetime.fromisoformat(batch.delivered_at)).days
            balance.extra_storage_kopecks += self.economics.excess_storage(days, units)
            balance.available += stock.available
        return RoutingRequest(
            sku=order.sku, quantity=order.quantity, unit_volume_cm3=product.unit_volume_cm3,
            wb_club=order.wb_club, pickup_point_id=pickup.id, requested_at=now,
            promised_by=order.promised_by,
            pickup_free_volume_cm3=self.destination_space(session, order),
            stock=list(balances.values()),
            resource_usage=reservations.resource_usage(session, now),
        )

    def destination_space(self, session: Session, order: Order) -> int:
        pickup = get_point(session, order.pickup_point_id)
        physical = point_view(session, pickup, self.reserve_percent).free_volume_cm3
        inbound = session.scalar(
            select(func.coalesce(func.sum(Order.quantity * Product.unit_volume_cm3), 0))
            .join_from(Order, Product, Order.sku == Product.sku)
            .where(
                Order.pickup_point_id == pickup.id, Order.id != order.id,
                Order.status.in_(("reserved", "packed", "in_transit", "awaiting_hub")),
                or_(Order.source_point_id.is_(None), Order.source_point_id != pickup.id),
            )
        )
        return max(0, physical - inbound)

    def assign(self, session: Session, order: Order, request: RoutingRequest, route: RouteDecision) -> None:
        source = route.source_point_id
        pickup = order.pickup_point_id
        valid_source = (
            (route.route_type == "hub" and source is None)
            or (order.wb_club and source is not None and source not in request.excluded_source_ids
                and (route.route_type == "shelf") == (source == pickup))
        )
        if (
            not valid_source or route.pickup_point_id != pickup
            or route.ready_at is None or not request.requested_at <= route.ready_at <= request.promised_by
        ):
            reject("invalid_route", "Модуль маршрутизации вернул несовместимый маршрут", 502)
        if route.route_type != "shelf":
            require_space(session, pickup, order.quantity * request.unit_volume_cm3, self.reserve_percent)
        if source is not None:
            candidates = session.scalars(
                select(Stock).join_from(Stock, Batch)
                .where(Stock.point_id == source, Batch.sku == order.sku, Stock.available > 0)
                .order_by(Batch.delivered_at, Batch.id)
            ).all()
            if sum(stock.available for stock in candidates) < order.quantity:
                reject("invalid_route_stock", "Маршрут выбрал ПВЗ без нужного остатка", 502)
            remaining = order.quantity
            for stock in candidates:
                quantity = min(remaining, stock.available)
                stock.available -= quantity
                stock.reserved += quantity
                session.add(Allocation(order_id=order.id, batch_id=stock.batch_id, quantity=quantity))
                remaining -= quantity
                if remaining == 0:
                    break

        order.route = route.model_dump(mode="json")
        order.source_point_id = source
        order.route_failure = None
        order.status = "awaiting_hub" if route.route_type == "hub" else "reserved"
        for resource in route.resources:
            reservations.reserve(session, order, resource)

    def create(self, command: OrderRequest) -> OrderView:
        order_id = uuid4().hex
        order = Order(
            id=order_id, scan_code=uuid4().hex, sku=command.sku, quantity=command.quantity,
            wb_club=command.wb_club, pickup_point_id=command.pickup_point_id,
            promised_by=command.promised_by.isoformat(), created_at=utc_now().isoformat(),
            status="awaiting_route",
        )
        with self.db.transaction() as session:
            replay = OperationLog(session, "create_order", command).replay()
            if replay:
                return self.view(session, get_order(session, replay.order_id))
            snapshot = self.routing_request(session, order)
        try:
            decision = self.routing.choose(snapshot)
            failure = None
        except NoRoute as error:
            decision, failure = None, error

        with self.db.transaction(write=True) as session:
            log = OperationLog(session, "create_order", command)
            replay = log.replay()
            if replay:
                return self.view(session, get_order(session, replay.order_id))
            current = self.routing_request(session, order)
            # Replan on concurrent inventory, window or trip changes, or an expired plan.
            if (
                snapshot.model_copy(update={"requested_at": current.requested_at}) != current
                or (decision is not None and (
                    decision.ready_at < current.requested_at
                    or any(resource.expires_at <= current.requested_at for resource in decision.resources)
                ))
            ):
                try:
                    decision, failure = self.routing.choose(current), None
                except NoRoute as error:
                    decision, failure = None, error
            if decision is None:
                reject("no_route", str(failure), reason_code=failure.reason_code)
            session.add(order)
            session.flush()
            self.assign(session, order, current, decision)
            log.record(
                "order_created", order.source_point_id or order.pickup_point_id,
                order.sku, order.quantity, order_id=order.id, details={"route": order.route},
            )
            return self.view(session, order)

    def release(
        self, session: Session, order: Order, disputed: int, batch_id: str | None = None,
    ) -> list[BatchAllocation]:
        if order.status not in {"reserved", "packed", "ready"}:
            return []
        bucket = "ready" if order.status == "ready" else "reserved"
        allocations = self.allocations(session, order)
        if batch_id is not None and not any(
            item.batch_id == batch_id and item.quantity >= disputed for item in allocations
        ):
            reject("invalid_shortage_batch", "В указанной партии нет такого резерва", 422)
        blocked_lots = []
        for allocation in allocations:
            stock = stock_at(session, allocation.batch_id, order.source_point_id)
            blocked = min(disputed, allocation.quantity) if batch_id in (None, allocation.batch_id) else 0
            setattr(stock, bucket, getattr(stock, bucket) - allocation.quantity)
            stock.available += allocation.quantity - blocked
            stock.blocked += blocked
            disputed -= blocked
            if blocked:
                blocked_lots.append(BatchAllocation(batch_id=allocation.batch_id, quantity=blocked))
            session.delete(allocation)
        session.flush()
        return blocked_lots

    def replan(
        self, session: Session, order: Order, cause: str, excluded: list[str], skip_trip: str | None,
    ) -> str | None:
        request = self.routing_request(session, order).model_copy(update={
            "replan_cause": cause,
            "excluded_source_ids": excluded,
            "excluded_trip_ids": [skip_trip] if skip_trip else [],
        })
        try:
            route = self.routing.choose(request)
        except NoRoute as error:
            order.route = None
            order.source_point_id = None
            order.status = "awaiting_route"
            order.route_failure = str(error)
            return error.reason_code
        else:
            self.assign(session, order, request, route)
            return None

    def update_transit(self, session: Session, order: Order, command: OrderCommand) -> dict:
        if command.actual_position is None:
            reject("position_required", "Укажите фактическое положение посылки", 422)
        observed_at = utc_now()
        old_route = RouteDecision.model_validate(order.route)
        remaining = command.remaining_travel_minutes
        if remaining is None:
            arrival = old_route.arrival_at or next(
                (step.ends_at for step in old_route.milestones if step.stage == "arrival"), None,
            )
            if command.actual_position == order.pickup_point_id:
                remaining = 0
            elif arrival is None:
                remaining = self.routing.schedule.travel_minutes
            else:
                remaining = max(0, ceil((arrival - observed_at).total_seconds() / 60))
        reservations.release_pending(session, order, "receive")
        product = get_product(session, order.sku)
        free_volume = self.destination_space(session, order)
        estimate = self.routing.estimate_transit(TransitRequest(
            order_id=order.id, pickup_point_id=order.pickup_point_id, actual_position=command.actual_position,
            observed_at=observed_at, promised_by=order.promised_by, quantity=order.quantity,
            pickup_free_units=free_volume // product.unit_volume_cm3, remaining_travel_minutes=remaining,
            resource_usage=reservations.resource_usage(session, observed_at),
        ))
        if estimate.resource is not None:
            reservations.reserve(session, order, estimate.resource)
        milestones = [step for step in old_route.milestones if step.stage not in {"arrival", "receive"}]
        milestones.append(RouteMilestone(
            stage="arrival", starts_at=estimate.arrival_at, ends_at=estimate.arrival_at,
            pvz_id=order.pickup_point_id,
        ))
        if estimate.receiving_slot is not None:
            milestones.append(estimate.receiving_slot)
        order.route = old_route.model_copy(update={
            "ready_at": estimate.ready_at, "reason": estimate.reason, "reason_code": estimate.reason_code,
            "arrival_at": estimate.arrival_at, "meets_deadline": estimate.meets_deadline,
            "milestones": tuple(milestones),
        }).model_dump(mode="json")
        order.actual_position = command.actual_position
        return {
            "actual_position": order.actual_position, "remaining_travel_minutes": remaining,
            "arrival_at": order.route["arrival_at"], "ready_at": order.route["ready_at"],
            "reason_code": estimate.reason_code,
        }

    @staticmethod
    def allocations(session: Session, order: Order) -> list[Allocation]:
        return session.scalars(
            select(Allocation).join_from(Allocation, Batch).where(Allocation.order_id == order.id)
            .order_by(Batch.delivered_at, Batch.id)
        ).all()

    def move_allocations(
        self, session: Session, order: Order, origin_id: str, origin_bucket: str | None,
        destination_id: str, destination_bucket: str | None,
    ) -> None:
        for allocation in self.allocations(session, order):
            if origin_bucket is not None:
                stock = stock_at(session, allocation.batch_id, origin_id)
                setattr(stock, origin_bucket, getattr(stock, origin_bucket) - allocation.quantity)
            if destination_bucket is not None:
                stock = stock_at(session, allocation.batch_id, destination_id)
                setattr(stock, destination_bucket, getattr(stock, destination_bucket) + allocation.quantity)

    def apply(self, session: Session, order_id: str, command: OrderCommand) -> OrderView:
        order = get_order(session, order_id)
        log = OperationLog(
            session, f"order/{order_id}", command, self.ledger, omit_if_none=("remaining_travel_minutes",),
        )
        if log.replay():
            return self.view(session, order)
        if command.scan_code != order.scan_code:
            reject("wrong_scan_code", "Код посылки не соответствует заказу", 422)
        kind = command.type
        point = command.point_id
        expected = action_points(order).get(kind)
        if expected is None:
            reject("invalid_order_status", "Операция недоступна на текущем этапе заказа")
        if point != expected:
            reject("wrong_point", "Операцию нужно выполнить в другом ПВЗ")
        if (command.shortage_quantity is not None or command.shortage_batch_id is not None) and kind != "shortage":
            reject("unexpected_shortage", "Количество недостачи указывается только для недостачи", 422)
        if (command.actual_position is not None or command.remaining_travel_minutes is not None) and kind != "update_transit":
            reject("unexpected_position", "Позиция указывается только при обновлении перевозки", 422)

        source = order.source_point_id
        pickup = order.pickup_point_id
        details = {"reason": command.reason} if command.reason else {}
        batch_id = None
        quantity = order.quantity
        if kind == "pack":
            reservations.consume(session, order, "pack")
            if order.route["route_type"] == "shelf":
                self.move_allocations(session, order, point, "reserved", point, "ready")
                order.status = "ready"
            else:
                order.status = "packed"
        elif kind == "handoff":
            reservations.consume(session, order, "load", "departure")
            self.move_allocations(session, order, point, "reserved", point, "in_transit")
            order.actual_position = point
            order.status = "in_transit"
        elif kind in {"receive", "confirm_hub_delivery", "return_good", "return_damaged"}:
            volume = get_product(session, order.sku).unit_volume_cm3 * order.quantity
            require_space(session, point, volume, self.reserve_percent)
            if kind == "confirm_hub_delivery":
                batch_id = f"hub-{order.id}"
                session.add(Batch(
                    id=batch_id, sku=order.sku, origin_point_id=point, received_quantity=order.quantity,
                    delivered_at=utc_now().isoformat(), simulated=True,
                ))
                session.flush()
                stock_at(session, batch_id, point).ready = order.quantity
                session.add(Allocation(order_id=order.id, batch_id=batch_id, quantity=order.quantity))
            elif kind == "receive":
                if order.route["ready_at"] is None:
                    reject("route_window_unavailable", "Нет подходящего окна приёмки, обновите положение посылки")
                reservations.consume(session, order, "receive")
                self.move_allocations(session, order, source, "in_transit", pickup, "ready")
            else:
                bucket = "available" if kind == "return_good" else "damaged"
                self.move_allocations(session, order, point, None, point, bucket)
            order.actual_position = point
            order.status = "returned" if kind.startswith("return_") else "ready"
        elif kind == "issue":
            self.move_allocations(session, order, point, "ready", point, None)
            order.actual_position = point
            order.status = "delivered"
        elif kind == "cancel":
            self.release(session, order, 0)
            reservations.release_pending(session, order)
            order.status = "cancelled"
        elif kind in {"shortage", "replan"}:
            disputed = (command.shortage_quantity or order.quantity) if kind == "shortage" else 0
            if disputed > order.quantity:
                reject("invalid_shortage", "Недостача превышает количество товаров в заказе", 422)
            details.update(previous_route=order.route, shortage_quantity=disputed)
            batch_id = command.shortage_batch_id
            blocked = self.release(session, order, disputed, batch_id)
            if kind == "shortage":
                quantity = disputed
                details["blocked_lots"] = [lot.model_dump() for lot in blocked]
            reservations.release_pending(session, order)
            cause = command.reason or ("недостача товара" if kind == "shortage" else "сбой до отправки")
            trip_id = order.route.get("trip_id") if order.route and kind == "replan" else None
            excluded = [source] if source and (kind == "shortage" or trip_id is None) else []
            failure_code = self.replan(session, order, cause, excluded, trip_id)
            details.update(route=order.route, route_failure=order.route_failure, reason_code=failure_code)
        elif kind == "update_transit":
            details.update(self.update_transit(session, order, command))
        log.record(
            kind, point, order.sku, quantity, order_id=order.id, batch_id=batch_id, details=details,
        )
        return self.view(session, order)

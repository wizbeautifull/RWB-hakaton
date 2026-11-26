from fastapi import APIRouter
from sqlalchemy import or_, select

from ..contracts import CheckoutOptions, CheckoutRequest, Code, OrderRequest, OrderStatus
from ..inventory.service import get_point
from ..models import Order
from .service import OrderCommand, Orders, OrderView, get_order


def order_router(orders: Orders) -> APIRouter:
    router = APIRouter(prefix="/api/orders", tags=["Заказы"])

    @router.post("", status_code=201)
    def post_order(command: OrderRequest) -> OrderView:
        return orders.create(command)

    @router.post("/options")
    def checkout_options(command: CheckoutRequest) -> CheckoutOptions:
        return orders.options(command)

    @router.get("")
    def get_orders(
        point_id: Code | None = None, status: OrderStatus | None = None, actionable: bool = False,
    ) -> list[OrderView]:
        query = select(Order).order_by(Order.created_at.desc(), Order.id)
        with orders.db.transaction() as session:
            if point_id is not None:
                get_point(session, point_id)
                query = query.where(or_(Order.pickup_point_id == point_id, Order.source_point_id == point_id))
            if status is not None:
                query = query.where(Order.status == status)
            views = [orders.view(session, order) for order in session.scalars(query)]
            if actionable:
                views = [
                    view for view in views
                    if any(point_id is None or action.point_id == point_id for action in view.next_actions)
                ]
            return views

    @router.get("/{order_id}")
    def read_order(order_id: Code) -> OrderView:
        with orders.db.transaction() as session:
            return orders.view(session, get_order(session, order_id))

    @router.post("/{order_id}/actions")
    def post_order_action(order_id: Code, command: OrderCommand) -> OrderView:
        with orders.db.transaction(write=True) as session:
            return orders.apply(session, order_id, command)

    return router

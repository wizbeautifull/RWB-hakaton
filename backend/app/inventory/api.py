from fastapi import APIRouter
from sqlalchemy import select

from ..config import PilotConfig
from ..contracts import Code, OperationEvent
from ..db import Database
from ..models import Point, Product
from ..operations import reject
from ..pricing.ledger import PricingLedger
from .service import (
    BatchView, PointInput, PointView, ProductRegistration, ProductView, Receipt, StockCommand, StockView,
    StorageConfirmation, change_stock, confirm_storage, list_stock, point_view, receive_batch,
    register_product,
)


def inventory_router(db: Database, pilot: PilotConfig, ledger: PricingLedger) -> APIRouter:
    router = APIRouter(prefix="/api", tags=["Остатки и поставки"])
    reserve = pilot.capacity_reserve_percent

    @router.put("/points/{point_id}")
    def put_point(point_id: Code, data: PointInput) -> PointView:
        with db.transaction(write=True) as session:
            point = session.get(Point, point_id)
            if point is None:
                point = Point(id=point_id, **data.model_dump())
                session.add(point)
                session.flush()
            elif (point.name, point.capacity_cm3) != (data.name, data.capacity_cm3):
                reject("point_conflict", "ПВЗ уже зарегистрирован с другими параметрами")
            return point_view(session, point, reserve)

    @router.get("/points")
    def get_points() -> list[PointView]:
        with db.transaction() as session:
            return [point_view(session, point, reserve) for point in session.scalars(select(Point).order_by(Point.id))]

    @router.put("/products/{sku}")
    def put_product(sku: Code, data: ProductRegistration) -> ProductView:
        with db.transaction(write=True) as session:
            return ProductView.model_validate(register_product(session, sku, data))

    @router.get("/products")
    def get_products() -> list[ProductView]:
        with db.transaction() as session:
            return [ProductView.model_validate(product) for product in session.scalars(select(Product).order_by(Product.sku))]

    @router.post("/batches", status_code=201)
    def post_batch(command: Receipt) -> BatchView:
        with db.transaction(write=True) as session:
            return receive_batch(session, command, reserve, ledger)

    @router.get("/inventory")
    def get_inventory(
        point_id: Code | None = None, sku: Code | None = None, seller_id: Code | None = None,
    ) -> list[StockView]:
        with db.transaction() as session:
            return list_stock(session, pilot.slow_stock_days, point_id, sku, seller_id)

    @router.post("/inventory/{point_id}/{batch_id}/actions")
    def post_stock_action(point_id: Code, batch_id: Code, command: StockCommand) -> StockView:
        with db.transaction(write=True) as session:
            return change_stock(
                session, point_id, batch_id, command,
                reserve_percent=reserve, slow_days=pilot.slow_stock_days,
            )

    @router.post("/inventory/{point_id}/{batch_id}/storage", status_code=201)
    def post_storage(point_id: Code, batch_id: Code, command: StorageConfirmation) -> OperationEvent:
        with db.transaction(write=True) as session:
            return confirm_storage(session, point_id, batch_id, command, ledger)

    return router

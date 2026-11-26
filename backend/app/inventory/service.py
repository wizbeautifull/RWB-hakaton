from datetime import datetime, timezone
from typing import Literal

from pydantic import AwareDatetime, Field
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from ..contracts import APIModel, Code, Command, OperationEvent, Quantity, Volume, utc_now
from ..models import Batch, Operation, Point, PointLocation, Product, Seller, Stock
from ..operations import OperationLog, reject
from ..pricing.ledger import PricingLedger


class Location(APIModel):
    longitude: float = Field(ge=-180, le=180)
    latitude: float = Field(ge=-90, le=90)
    address: str | None = Field(default=None, min_length=1, max_length=240)


class PointInput(APIModel):
    name: Code
    capacity_cm3: Volume
    location: Location | None = None


class PointView(PointInput):
    id: Code
    usable_capacity_cm3: int
    occupied_volume_cm3: int
    free_volume_cm3: int


class ProductInput(APIModel):
    seller_id: Code
    unit_volume_cm3: Volume


class ProductView(ProductInput):
    sku: Code


class ProductRegistration(ProductInput):
    seller_name: Code | None = None


class Receipt(Command, ProductRegistration):
    batch_id: Code
    sku: Code
    point_id: Code
    quantity: Quantity
    delivered_at: AwareDatetime


class BatchView(Receipt):
    simulated: bool


class StockView(ProductView):
    seller_name: Code | None = None
    batch_id: Code
    point_id: Code
    delivered_at: AwareDatetime
    storage_days: int
    slow_stock: bool
    available: int
    reserved: int
    in_transit: int
    ready: int
    blocked: int
    damaged: int


class StockCommand(Command):
    type: Literal["reconcile_found", "reconcile_missing", "move_slow", "remove_slow", "send_damaged_to_hub"]
    quantity: Quantity
    destination_point_id: Code | None = None


class StorageConfirmation(Command):
    quantity: Quantity


def get_point(session: Session, point_id: str) -> Point:
    point = session.get(Point, point_id)
    if point is None:
        reject("point_not_found", "ПВЗ не найден", 404)
    return point


def get_product(session: Session, sku: str) -> Product:
    product = session.get(Product, sku)
    if product is None:
        reject("product_not_found", "Код товара не найден", 404)
    return product


def register_product(session: Session, sku: str, data: ProductRegistration) -> Product:
    product = session.get(Product, sku)
    if product is None:
        product = Product(sku=sku, seller_id=data.seller_id, unit_volume_cm3=data.unit_volume_cm3)
        session.add(product)
        session.flush()
    elif (product.seller_id, product.unit_volume_cm3) != (data.seller_id, data.unit_volume_cm3):
        reject("product_conflict", "У товара уже зарегистрирован другой продавец или объём")
    if data.seller_name is not None:
        seller = session.get(Seller, data.seller_id)
        if seller is None:
            session.add(Seller(id=data.seller_id, name=data.seller_name))
        else:
            seller.name = data.seller_name
    return product


def point_view(
    session: Session, point: Point, reserve_percent: int, location: PointLocation | None = None,
) -> PointView:
    physical = Stock.available + Stock.reserved + Stock.ready + Stock.blocked + Stock.damaged
    occupied = session.scalar(
        select(func.coalesce(func.sum(physical * Product.unit_volume_cm3), 0))
        .join_from(Stock, Batch).join(Product).where(Stock.point_id == point.id)
    )
    usable = point.capacity_cm3 * (100 - reserve_percent) // 100
    return PointView(
        id=point.id, name=point.name, capacity_cm3=point.capacity_cm3,
        location=Location.model_validate(location) if location is not None else None,
        usable_capacity_cm3=usable, occupied_volume_cm3=occupied,
        free_volume_cm3=max(0, usable - occupied),
    )


def require_space(session: Session, point_id: str, volume: int, reserve_percent: int) -> None:
    if point_view(session, get_point(session, point_id), reserve_percent).free_volume_cm3 < volume:
        reject("capacity_exceeded", "В ПВЗ нет места для приёмки с учётом резерва")


def stock_at(session: Session, batch_id: str, point_id: str) -> Stock:
    stock = session.get(Stock, (batch_id, point_id))
    if stock is None:
        stock = Stock(batch_id=batch_id, point_id=point_id)
        session.add(stock)
        session.flush()
    return stock


def receive_batch(
    session: Session, command: Receipt, reserve_percent: int, ledger: PricingLedger,
) -> BatchView:
    log = OperationLog(session, "receipt", command, ledger, omit_if_none=("seller_name",))
    replay = log.replay()
    if replay:
        return BatchView(**command.model_dump(), simulated=False)
    if session.get(Batch, command.batch_id):
        reject("batch_exists", "Партия с этим номером уже принята")
    if command.batch_id.startswith("hub-"):
        reject("invalid_batch_id", "Префикс hub- зарезервирован для моделируемых поставок", 422)
    if command.delivered_at > utc_now():
        reject("future_delivery", "Дата поставки ещё не наступила", 422)
    require_space(session, command.point_id, command.quantity * command.unit_volume_cm3, reserve_percent)
    register_product(session, command.sku, command)
    session.add(Batch(
        id=command.batch_id, sku=command.sku, origin_point_id=command.point_id,
        received_quantity=command.quantity,
        delivered_at=command.delivered_at.astimezone(timezone.utc).isoformat(),
    ))
    session.flush()
    stock_at(session, command.batch_id, command.point_id).available = command.quantity
    log.record("batch_received", command.point_id, command.sku, command.quantity, batch_id=command.batch_id)
    return BatchView(**command.model_dump(), simulated=False)


def confirm_storage(
    session: Session, point_id: str, batch_id: str, command: StorageConfirmation, ledger: PricingLedger,
) -> OperationEvent:
    log = OperationLog(session, f"storage/{point_id}/{batch_id}", command, ledger)
    if replay := log.replay():
        return OperationEvent.model_validate(replay.payload)
    stock = session.get(Stock, (batch_id, point_id))
    if stock is None:
        reject("stock_not_found", "Партия в этом ПВЗ не найдена", 404)
    day = utc_now().date().isoformat()
    existing = session.scalar(select(Operation.event_id).where(
        Operation.point_id == point_id, Operation.batch_id == batch_id,
        Operation.payload["type"].as_string() == "storage",
        Operation.payload["details"]["storage_date"].as_string() == day,
    ))
    if existing is not None:
        reject("storage_already_confirmed", "Хранение этой партии в ПВЗ сегодня уже подтверждено")
    if command.quantity > stock.available + stock.reserved + stock.ready:
        reject("insufficient_stock", "Подтверждённое количество превышает товар на полке")
    batch = session.get(Batch, batch_id)
    return log.record("storage", point_id, batch.sku, command.quantity, batch_id=batch_id,
                      details={"storage_date": day})


def storage_days(batch: Batch) -> int:
    return max(0, (utc_now() - datetime.fromisoformat(batch.delivered_at)).days)


def stock_view(stock: Stock, batch: Batch, product: Product, seller_name: str | None, slow_days: int) -> StockView:
    days = storage_days(batch)
    return StockView(
        batch_id=batch.id, point_id=stock.point_id, sku=product.sku, seller_id=product.seller_id,
        seller_name=seller_name, unit_volume_cm3=product.unit_volume_cm3, delivered_at=batch.delivered_at,
        storage_days=days, slow_stock=stock.available > 0 and days >= slow_days,
        available=stock.available, reserved=stock.reserved, in_transit=stock.in_transit,
        ready=stock.ready, blocked=stock.blocked, damaged=stock.damaged,
    )


def list_stock(
    session: Session, slow_days: int, point_id: str | None, sku: str | None, seller_id: str | None,
) -> list[StockView]:
    query = (select(Stock, Batch, Product, Seller.name).join_from(Stock, Batch).join(Product)
             .outerjoin(Seller, Seller.id == Product.seller_id))
    if point_id is not None:
        get_point(session, point_id)
        query = query.where(Stock.point_id == point_id)
    if sku is not None:
        query = query.where(Product.sku == sku)
    if seller_id is not None:
        query = query.where(Product.seller_id == seller_id)
    return [
        stock_view(stock, batch, product, seller_name, slow_days)
        for stock, batch, product, seller_name in session.execute(query.order_by(Stock.point_id, Batch.id))
    ]


def change_stock(
    session: Session, point_id: str, batch_id: str, command: StockCommand,
    *, reserve_percent: int, slow_days: int,
) -> StockView:
    log = OperationLog(session, f"stock/{point_id}/{batch_id}", command)
    replay = log.replay()
    stock = session.get(Stock, (batch_id, point_id))
    if stock is None:
        reject("stock_not_found", "Партия в этом ПВЗ не найдена", 404)
    batch = session.get(Batch, batch_id)
    product = get_product(session, batch.sku)
    seller_name = session.scalar(select(Seller.name).where(Seller.id == product.seller_id))
    if replay:
        return stock_view(stock, batch, product, seller_name, slow_days)
    target = command.destination_point_id
    if command.type == "move_slow":
        if target is None or point_id == target:
            reject("invalid_destination", "Укажите другой ПВЗ для переноса", 422)
    elif target is not None:
        reject("invalid_destination", "ПВЗ назначения нужен только для переноса", 422)

    if command.type in ("move_slow", "remove_slow"):
        if storage_days(batch) < slow_days:
            reject("stock_not_slow", "Порог длительного хранения ещё не достигнут")
        bucket = "available"
    elif command.type == "send_damaged_to_hub":
        bucket = "damaged"
    else:
        bucket = "blocked"
    balance = getattr(stock, bucket)
    if command.quantity > balance:
        reject("insufficient_stock", "В указанном состоянии недостаточно единиц")
    if target is not None:
        require_space(session, target, command.quantity * product.unit_volume_cm3, reserve_percent)
        stock_at(session, batch_id, target).available += command.quantity
    if command.type == "reconcile_found":
        stock.available += command.quantity
    setattr(stock, bucket, balance - command.quantity)
    log.record(
        command.type, point_id, batch.sku, command.quantity, batch_id=batch_id,
        details={"destination_point_id": target} if target else None,
    )
    return stock_view(stock, batch, product, seller_name, slow_days)

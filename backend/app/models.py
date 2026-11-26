from sqlalchemy import JSON, CheckConstraint, ForeignKey, String
from sqlalchemy.orm import Mapped, mapped_column

from .db import Base


class Point(Base):
    __tablename__ = "points"

    id: Mapped[str] = mapped_column(String, primary_key=True)
    name: Mapped[str]
    capacity_cm3: Mapped[int]


class Seller(Base):
    __tablename__ = "sellers"

    id: Mapped[str] = mapped_column(String, primary_key=True)
    name: Mapped[str]


class Product(Base):
    __tablename__ = "products"

    sku: Mapped[str] = mapped_column(String, primary_key=True)
    seller_id: Mapped[str]
    unit_volume_cm3: Mapped[int]


class Batch(Base):
    __tablename__ = "batches"

    id: Mapped[str] = mapped_column(String, primary_key=True)
    sku: Mapped[str] = mapped_column(ForeignKey("products.sku"), index=True)
    origin_point_id: Mapped[str] = mapped_column(ForeignKey("points.id"))
    received_quantity: Mapped[int]
    delivered_at: Mapped[str]
    simulated: Mapped[bool] = mapped_column(default=False)


class Stock(Base):
    __tablename__ = "stock"
    __table_args__ = (
        CheckConstraint(
            "available >= 0 AND reserved >= 0 AND in_transit >= 0 "
            "AND ready >= 0 AND blocked >= 0 AND damaged >= 0"
        ),
    )

    batch_id: Mapped[str] = mapped_column(ForeignKey("batches.id"), primary_key=True)
    point_id: Mapped[str] = mapped_column(ForeignKey("points.id"), primary_key=True, index=True)
    available: Mapped[int] = mapped_column(default=0)
    reserved: Mapped[int] = mapped_column(default=0)
    in_transit: Mapped[int] = mapped_column(default=0)
    ready: Mapped[int] = mapped_column(default=0)
    blocked: Mapped[int] = mapped_column(default=0)
    damaged: Mapped[int] = mapped_column(default=0)


class Order(Base):
    __tablename__ = "orders"

    id: Mapped[str] = mapped_column(String, primary_key=True)
    scan_code: Mapped[str] = mapped_column(unique=True)
    sku: Mapped[str] = mapped_column(ForeignKey("products.sku"), index=True)
    quantity: Mapped[int]
    wb_club: Mapped[bool]
    fulfillment: Mapped[str | None]
    pickup_point_id: Mapped[str] = mapped_column(ForeignKey("points.id"), index=True)
    source_point_id: Mapped[str | None] = mapped_column(ForeignKey("points.id"), index=True)
    promised_by: Mapped[str]
    status: Mapped[str]
    route: Mapped[dict | None] = mapped_column(JSON)
    route_failure: Mapped[str | None]
    actual_position: Mapped[str | None]
    created_at: Mapped[str] = mapped_column(index=True)


class Allocation(Base):
    __tablename__ = "allocations"

    order_id: Mapped[str] = mapped_column(ForeignKey("orders.id"), primary_key=True)
    batch_id: Mapped[str] = mapped_column(ForeignKey("batches.id"), primary_key=True)
    quantity: Mapped[int]


class RouteReservation(Base):
    __tablename__ = "route_reservations"

    id: Mapped[int] = mapped_column(primary_key=True)
    order_id: Mapped[str] = mapped_column(ForeignKey("orders.id"), index=True)
    stage: Mapped[str]
    resource_key: Mapped[str] = mapped_column(index=True)
    expires_at: Mapped[str] = mapped_column(index=True)
    quantity: Mapped[int]
    order_index: Mapped[int | None]
    consumed: Mapped[bool] = mapped_column(default=False)


class Operation(Base):
    __tablename__ = "operations"

    event_id: Mapped[str] = mapped_column(String, primary_key=True)
    request_id: Mapped[str] = mapped_column(unique=True)
    fingerprint: Mapped[str]
    payload: Mapped[dict] = mapped_column(JSON)
    point_id: Mapped[str] = mapped_column(ForeignKey("points.id"), index=True)
    order_id: Mapped[str | None] = mapped_column(ForeignKey("orders.id"), index=True)
    batch_id: Mapped[str | None] = mapped_column(ForeignKey("batches.id"), index=True)
    occurred_at: Mapped[str] = mapped_column(index=True)
    sequence: Mapped[int] = mapped_column(unique=True)

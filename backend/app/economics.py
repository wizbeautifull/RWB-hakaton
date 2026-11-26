from pydantic import BaseModel, Field


class SellerTerms(BaseModel):
    sale_kopecks: int = Field(default=50_000, ge=0)
    goods_kopecks: int = Field(default=24_000, ge=0)
    commission_bps: int = Field(default=2_000, ge=0, le=10_000)
    shelf_logistics_kopecks: int = Field(default=3_500, ge=0)
    direct_logistics_kopecks: int = Field(default=5_000, ge=0)
    hub_logistics_kopecks: int = Field(default=6_000, ge=0)
    storage_unit_day_kopecks: int = Field(default=100, ge=0)
    return_unit_kopecks: int = Field(default=2_500, ge=0)


class EconomicsConfig(BaseModel):
    included_storage_days: int = Field(default=4, ge=0)
    marketplace_storage_unit_day_kopecks: int = Field(default=300, ge=0)
    return_probability_bps: int = Field(default=1_000, ge=0, le=10_000)
    marketplace_return_kopecks: int = Field(default=12_000, ge=0)
    buyer_acceleration_fee_kopecks: int = Field(default=0, ge=0)
    seller_default: SellerTerms = Field(default_factory=SellerTerms)
    seller_by_sku: dict[str, SellerTerms] = Field(default_factory=dict)
    point_operation_costs_kopecks: dict[str, int] = Field(default_factory=lambda: {
        "intake": 200, "storage": 60, "pack": 900, "handover": 300,
        "transfer_receive": 300, "issue": 1200, "return": 700,
    })

    def excess_storage(self, days: int, units: int = 1) -> int:
        return max(0, days - self.included_storage_days) * self.marketplace_storage_unit_day_kopecks * units


def rate_amount(amount_kopecks: int, basis_points: int) -> int:
    return (amount_kopecks * basis_points + 5_000) // 10_000

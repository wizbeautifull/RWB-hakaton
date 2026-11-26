import argparse
import json
from datetime import timedelta
from urllib.request import Request, urlopen

from .contracts import utc_now


def seed(base_url: str) -> None:
    def api(path: str, method: str = "GET", data: dict | None = None):
        body = json.dumps(data).encode() if data is not None else None
        request = Request(
            base_url.rstrip("/") + "/api" + path, data=body, method=method,
            headers={"Content-Type": "application/json"},
        )
        with urlopen(request, timeout=10) as response:
            return json.load(response)

    existing = {point["id"] for point in api("/points")}
    for code, name, capacity in (("A", "ПВЗ А", 1000), ("B", "ПВЗ Б", 1000), ("C", "ПВЗ В", 1500)):
        if code not in existing:
            api(f"/points/{code}", "PUT", {"name": name, "capacity_cm3": capacity})

    for batch_id, sku, quantity, days in (
        ("demo-cables", "CABLE", 3, 1),
        ("demo-aged", "ADAPTER", 2, 40),
    ):
        if api(f"/operations?batch_id={batch_id}"):
            continue
        api("/batches", "POST", {
            "request_id": batch_id, "batch_id": batch_id, "sku": sku, "point_id": "A",
            "seller_id": "seller-1", "quantity": quantity, "unit_volume_cm3": 100,
            "delivered_at": (utc_now() - timedelta(days=days, minutes=1)).isoformat(),
        })


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Начальные данные для показа Wildberries Mesh")
    parser.add_argument("--url", default="http://127.0.0.1:8000")
    seed(parser.parse_args().url)
    print("Начальные данные готовы. Точки A, B, C и продавец seller-1.")

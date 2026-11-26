"""Проверки доступности, выбор маршрута и пересчёт срока.

Расчёт работает на переданном снимке и не меняет остатки, окна и рейсы.
Сервис заказов подтверждает резерв в своей транзакции.
"""

from datetime import datetime, timedelta
from typing import Literal

from ..pricing.costs import CostBreakdown, PilotPricing, direct_breakdown
from .models import (
    CandidateEvaluation,
    DirectTrip,
    Fulfillment,
    InTransitUpdate,
    PickupPoint,
    RouteDecision,
    RouteMilestone,
    RouteQuote,
    RouteRequest,
    RouteType,
    Stage,
    TransitEstimate,
    Window,
)

REASONS = {
    "shelf_ready": "Товар можно собрать в выбранном ПВЗ к сроку.",
    "shelf_no_stock": "В выбранном ПВЗ не хватает доступного остатка.",
    "shelf_pack_window": "В выбранном ПВЗ нет свободного окна сборки.",
    "shelf_after_deadline": "Сборка с полки завершается после обещанного срока.",
    "shelf_more_expensive": "С учётом хранения выдача с полки дороже доступного хаба.",
    "shelf_priority": "Выдача с полки уже доступна к сроку и имеет приоритет.",
    "delivery_requested": "Покупатель выбрал доставку в выбранный ПВЗ.",
    "direct_ready": "Прямой рейс укладывается в срок, окна и доступную ёмкость.",
    "direct_cheaper": "Прямой рейс укладывается в срок и дешевле хаба.",
    "direct_only": "Прямой рейс укладывается в срок, хаб сейчас недоступен.",
    "hub_required_for_comparison": "Для прямого рейса требуется доступное предложение хаба.",
    "club_required": "Без WB Клуба доступна обычная доставка через хаб.",
    "no_city_stock": "В других ПВЗ города нет нужного доступного остатка.",
    "no_direct_trip": "Для доступного остатка нет подходящего рейса или места на нём.",
    "direct_other_city": "Источник рейса находится в другом городе.",
    "direct_no_stock": "В источнике рейса не хватает доступного остатка.",
    "direct_already_departed": "Отправление рейса уже прошло.",
    "direct_no_capacity": "На рейсе не хватает места для всего заказа.",
    "direct_pack_window": "В ПВЗ отправления нет свободного окна сборки.",
    "direct_load_window": "Погрузка не помещается в свободное окно до отправления.",
    "direct_receive_window": "В ПВЗ выдачи нет свободного окна приёмки после прибытия.",
    "direct_windows_unavailable": "ПВЗ не успевают обработать товар в допустимые окна.",
    "direct_after_deadline": "Прямой рейс не укладывается в обещанный срок.",
    "hub_ready": "Хаб подтверждает остаток и готовность к сроку.",
    "hub_same_price": "При равной стоимости выбран хаб.",
    "hub_cheaper": "При текущей загрузке прямой рейс дороже хаба.",
    "hub_no_stock": "Для доставки через хаб нет доступного остатка или предложения.",
    "hub_eta_stale": "Расчёт срока через хаб устарел.",
    "hub_after_deadline": "Хаб не укладывается в обещанный срок.",
    "deadline_passed": "Обещанный срок уже прошёл.",
}

WINDOW_BLOCKERS = {"direct_pack_window", "direct_load_window", "direct_receive_window"}


def _slot(
    stage: Stage,
    windows: tuple[Window, ...],
    earliest: datetime,
    minutes: int,
    quantity: int,
    *,
    pvz_id: str,
    latest_finish: datetime | None = None,
) -> RouteMilestone | None:
    """Находит первое окно, в котором работа целиком помещается по времени и ёмкости."""
    duration = timedelta(minutes=minutes)
    for window in sorted(windows, key=lambda slot: (slot.start, slot.end, slot.window_id or "")):
        if window.free_units < quantity or window.end <= earliest:
            continue
        start = max(window.start, earliest)
        end = start + duration
        if end <= window.end and (latest_finish is None or end <= latest_finish):
            return RouteMilestone(
                stage=stage,
                starts_at=start,
                ends_at=end,
                pvz_id=pvz_id,
                window_id=window.window_id,
            )
    return None


def _candidate(
    route: RouteType,
    code: str,
    *,
    source_id: str | None = None,
    trip_id: str | None = None,
    status: Literal["eligible", "rejected", "skipped"] = "rejected",
    milestones: tuple[RouteMilestone, ...] = (),
    quote: RouteQuote | None = None,
) -> CandidateEvaluation:
    return CandidateEvaluation(
        route_type=route,
        source_id=source_id,
        trip_id=trip_id,
        status=status,
        reason_code=code,
        reason=REASONS[code],
        milestones=milestones,
        quote=quote,
    )


def _quoted_candidate(
    route: RouteType,
    source_id: str,
    milestones: tuple[RouteMilestone, ...],
    cost: CostBreakdown,
    deadline: datetime,
    ready_code: str,
    late_code: str,
    trip_id: str | None = None,
) -> CandidateEvaluation:
    ready_at = milestones[-1].ends_at
    on_time = ready_at <= deadline
    return _candidate(
        route,
        ready_code if on_time else late_code,
        source_id=source_id,
        trip_id=trip_id,
        status="eligible" if on_time else "rejected",
        milestones=milestones,
        quote=RouteQuote(
            route_type=route,
            source_id=source_id,
            trip_id=trip_id,
            ready_at=ready_at,
            cost_kopecks=cost.total_kopecks,
            cost_breakdown=cost,
            milestones=milestones,
        ),
    )


def _hub(request: RouteRequest, pricing: PilotPricing) -> CandidateEvaluation:
    hub = request.hub
    if hub is None or hub.available < request.quantity:
        return _candidate(RouteType.HUB, "hub_no_stock", source_id=hub.source_id if hub else None)
    if hub.ready_at < request.now:
        return _candidate(RouteType.HUB, "hub_eta_stale", source_id=hub.source_id)

    ready = RouteMilestone(
        stage="hub_ready",
        starts_at=hub.ready_at,
        ends_at=hub.ready_at,
        pvz_id=request.pickup_pvz_id,
    )
    cost = CostBreakdown(
        base_kopecks=pricing.hub_per_order_kopecks,
        additional_kopecks=hub.additional_kopecks,
    )
    return _quoted_candidate(
        RouteType.HUB,
        hub.source_id,
        (ready,),
        cost,
        request.deadline,
        "hub_ready",
        "hub_after_deadline",
    )


def _shelf(
    request: RouteRequest,
    pricing: PilotPricing,
    point: PickupPoint,
    available: int,
    extra_storage_kopecks: int,
) -> CandidateEvaluation:
    if available < request.quantity:
        return _candidate(RouteType.SHELF, "shelf_no_stock", source_id=point.pvz_id)
    pack = _slot(
        "pack",
        point.pack_windows,
        request.now,
        point.pack_minutes,
        request.quantity,
        pvz_id=point.pvz_id,
    )
    if pack is None:
        return _candidate(RouteType.SHELF, "shelf_pack_window", source_id=point.pvz_id)
    return _quoted_candidate(
        RouteType.SHELF,
        point.pvz_id,
        (pack,),
        CostBreakdown(base_kopecks=pricing.shelf_per_order_kopecks, additional_kopecks=extra_storage_kopecks),
        request.deadline,
        "shelf_ready",
        "shelf_after_deadline",
    )


def _direct(
    request: RouteRequest,
    pricing: PilotPricing,
    trip: DirectTrip,
    source: PickupPoint,
    target: PickupPoint,
    available: int,
    extra_storage_kopecks: int,
) -> CandidateEvaluation:
    def reject(code: str, milestones: tuple[RouteMilestone, ...] = ()) -> CandidateEvaluation:
        return _candidate(
            RouteType.DIRECT,
            code,
            source_id=source.pvz_id,
            trip_id=trip.trip_id,
            milestones=milestones,
        )

    if source.city_id != target.city_id:
        return reject("direct_other_city")
    if available < request.quantity:
        return reject("direct_no_stock")
    if trip.departure_at < request.now:
        return reject("direct_already_departed")
    if trip.free_units < request.quantity:
        return reject("direct_no_capacity")

    pack = _slot(
        "pack",
        source.pack_windows,
        request.now,
        source.pack_minutes,
        request.quantity,
        pvz_id=source.pvz_id,
    )
    if pack is None:
        return reject("direct_pack_window")
    load = _slot(
        "load",
        source.load_windows,
        pack.ends_at,
        source.load_minutes,
        request.quantity,
        pvz_id=source.pvz_id,
        latest_finish=trip.departure_at,
    )
    if load is None:
        return reject("direct_load_window", (pack,))

    arrival_at = trip.departure_at + timedelta(minutes=trip.travel_minutes)
    departure = RouteMilestone(
        stage="departure",
        starts_at=trip.departure_at,
        ends_at=trip.departure_at,
        pvz_id=source.pvz_id,
    )
    arrival = RouteMilestone(
        stage="arrival",
        starts_at=arrival_at,
        ends_at=arrival_at,
        pvz_id=target.pvz_id,
    )
    receive = _slot(
        "receive",
        target.receive_windows,
        arrival_at,
        target.receive_minutes,
        request.quantity,
        pvz_id=target.pvz_id,
    )
    if receive is None:
        return reject("direct_receive_window", (pack, load, departure, arrival))

    cost = direct_breakdown(
        pricing,
        loaded_orders=trip.loaded_orders,
        order_index=trip.order_index,
        trip=trip.trip_kopecks,
        stops=trip.stops_kopecks,
        shared_idle=trip.shared_idle_kopecks,
        empty_mileage=trip.empty_mileage_kopecks,
        individual_idle=trip.individual_idle_kopecks,
        retained_hub=trip.retained_hub_kopecks,
        additional_kopecks=extra_storage_kopecks,
    )
    return _quoted_candidate(
        RouteType.DIRECT,
        source.pvz_id,
        (pack, load, departure, arrival, receive),
        cost,
        request.deadline,
        "direct_ready",
        "direct_after_deadline",
        trip_id=trip.trip_id,
    )


def _decision(
    request: RouteRequest,
    selected: CandidateEvaluation | None,
    reason_code: str,
    candidates: tuple[CandidateEvaluation, ...] = (),
    *,
    direct: RouteQuote | None = None,
    hub: RouteQuote | None = None,
    related_reason: str | None = None,
) -> RouteDecision:
    quote = selected.quote if selected else None
    reason = REASONS[reason_code]
    if related_reason:
        reason = f"{reason} {REASONS[related_reason]}"
    return RouteDecision(
        route_type=quote.route_type if quote else RouteType.UNAVAILABLE,
        pickup_pvz_id=request.pickup_pvz_id,
        source_id=quote.source_id if quote else None,
        ready_at=quote.ready_at if quote else None,
        cost_kopecks=quote.cost_kopecks if quote else None,
        trip_id=quote.trip_id if quote else None,
        reason_code=reason_code,
        reason=reason,
        direct_option=direct,
        hub_option=hub,
        selected_option=quote,
        evaluations=tuple(
            candidate.model_copy(update={"status": "selected"}) if candidate is selected else candidate
            for candidate in candidates
        ),
    )


def _direct_blocker(
    candidates: tuple[CandidateEvaluation, ...],
    request: RouteRequest,
    points: dict[str, PickupPoint],
    target: PickupPoint,
    available: dict[str, int],
) -> str:
    codes = {candidate.reason_code for candidate in candidates}
    if "direct_after_deadline" in codes:
        return "direct_after_deadline"
    if codes & WINDOW_BLOCKERS:
        return "direct_windows_unavailable"
    if any(
        pvz_id != target.pvz_id
        and points[pvz_id].city_id == target.city_id
        and quantity >= request.quantity
        for pvz_id, quantity in available.items()
    ):
        return "no_direct_trip"
    return "no_city_stock"


def choose_route(
    request: RouteRequest, pricing: PilotPricing, *, fulfillment: Fulfillment | None = None,
) -> RouteDecision:
    """Выбор по порядку бизнес-правил. Варианты без свободного окна исключаются до сравнения цен."""
    if request.now > request.deadline:
        return _decision(request, None, "deadline_passed")

    hub = _hub(request, pricing)
    if not request.wb_club and fulfillment != "shelf_today":
        candidates = (
            _candidate(RouteType.SHELF, "club_required", status="skipped"),
            _candidate(RouteType.DIRECT, "club_required", status="skipped"),
            hub,
        )
        if hub.status == "eligible":
            return _decision(request, hub, "club_required", candidates, hub=hub.quote)
        return _decision(
            request,
            None,
            hub.reason_code,
            candidates,
            hub=hub.quote,
            related_reason="club_required",
        )

    points = {point.pvz_id: point for point in request.pickup_points}
    target = points[request.pickup_pvz_id]
    available = {
        row.pvz_id: row.available for row in request.stock if row.product_id == request.product_id
    }
    storage = {
        row.pvz_id: row.extra_storage_kopecks for row in request.stock if row.product_id == request.product_id
    }
    shelf = (
        _candidate(RouteType.SHELF, "delivery_requested", status="skipped")
        if fulfillment == "delivery"
        else _shelf(request, pricing, target, available.get(target.pvz_id, 0), storage.get(target.pvz_id, 0))
    )
    if fulfillment == "shelf_today":
        return _decision(request, shelf if shelf.status == "eligible" else None, shelf.reason_code, (shelf,))
    if shelf.status == "eligible":
        if hub.status != "eligible" or shelf.quote.cost_kopecks <= hub.quote.cost_kopecks:
            candidates = (shelf, _candidate(RouteType.DIRECT, "shelf_priority", status="skipped"), hub)
            return _decision(request, shelf, "shelf_ready", candidates, hub=hub.quote)
        shelf = shelf.model_copy(update={
            "status": "rejected", "reason_code": "shelf_more_expensive", "reason": REASONS["shelf_more_expensive"],
        })

    flights = tuple(
        _direct(
            request, pricing, trip, points[trip.source_id], target,
            available.get(trip.source_id, 0), storage.get(trip.source_id, 0),
        )
        for trip in sorted(request.direct_trips, key=lambda candidate: candidate.trip_id)
        if trip.pickup_pvz_id == target.pvz_id
    )
    blocker = _direct_blocker(flights, request, points, target, available)
    candidates = (shelf, *(flights or (_candidate(RouteType.DIRECT, blocker),)), hub)
    quoted = sorted(
        (flight.quote for flight in flights if flight.quote is not None),
        key=lambda quote: (quote.cost_kopecks, quote.ready_at, quote.trip_id or ""),
    )
    best = next((quote for quote in quoted if quote.ready_at <= request.deadline), None)
    best_candidate = next(
        (flight for flight in flights if best is not None and flight.quote is best), None
    )
    shown = best or (quoted[0] if quoted else None)

    if best is None or best_candidate is None:
        if hub.status == "eligible":
            reason = shelf.reason_code if shelf.reason_code == "shelf_more_expensive" else blocker
            return _decision(request, hub, reason, candidates, direct=shown, hub=hub.quote)
        return _decision(
            request,
            None,
            blocker,
            candidates,
            direct=shown,
            hub=hub.quote,
            related_reason=hub.reason_code,
        )

    if hub.status != "eligible" or hub.quote is None:
        if pricing.allow_direct_without_eligible_hub:
            return _decision(
                request,
                best_candidate,
                "direct_only",
                candidates,
                direct=best,
                hub=hub.quote,
                related_reason=hub.reason_code,
            )
        return _decision(
            request,
            None,
            "hub_required_for_comparison",
            candidates,
            direct=best,
            hub=hub.quote,
            related_reason=hub.reason_code,
        )

    if best.cost_kopecks < hub.quote.cost_kopecks:
        return _decision(
            request, best_candidate, "direct_cheaper", candidates, direct=best, hub=hub.quote
        )
    reason = "hub_same_price" if best.cost_kopecks == hub.quote.cost_kopecks else "hub_cheaper"
    return _decision(request, hub, reason, candidates, direct=best, hub=hub.quote)


def recalculate_before_dispatch(
    request: RouteRequest,
    pricing: PilotPricing,
    *,
    failure: str,
    excluded_source_ids: frozenset[str] = frozenset(),
    excluded_trip_ids: frozenset[str] = frozenset(),
    fulfillment: Fulfillment | None = None,
) -> RouteDecision:
    """Сравнивает обновлённые предложения после сбоя и сохраняет причину пересчёта."""
    hub = request.hub
    if hub is not None and hub.source_id in excluded_source_ids:
        hub = None
    snapshot = request.model_copy(
        update={
            "stock": tuple(row for row in request.stock if row.pvz_id not in excluded_source_ids),
            "direct_trips": tuple(
                trip for trip in request.direct_trips if trip.trip_id not in excluded_trip_ids
            ),
            "hub": hub,
        }
    )
    decision = choose_route(snapshot, pricing, fulfillment=fulfillment)
    return decision.model_copy(
        update={
            "reason": f"Пересчёт ({failure}). {decision.reason}",
            "replan_cause": failure,
        }
    )


def estimate_in_transit(update: InTransitUpdate) -> TransitEstimate:
    """Сохраняет действующий маршрут и пересчитывает срок по фактическому положению."""
    arrival = update.observed_at + timedelta(minutes=update.remaining_travel_minutes)
    point = update.pickup_point
    receive = _slot(
        "receive",
        point.receive_windows,
        arrival,
        point.receive_minutes,
        update.quantity,
        pvz_id=point.pvz_id,
    )
    ready_at = receive.ends_at if receive else None
    meets_deadline = ready_at is not None and ready_at <= update.deadline
    if ready_at is None:
        code, reason = "receive_window_missing", "Для фактического прибытия нет окна приёмки."
    elif meets_deadline:
        code, reason = "in_transit_on_time", "По текущему положению заказ успевает к сроку."
    else:
        code, reason = "in_transit_late", "Обновлённый срок готовности позже обещанного."
    return TransitEstimate(
        current_location_id=update.current_location_id,
        pickup_pvz_id=point.pvz_id,
        arrival_at=arrival,
        ready_at=ready_at,
        meets_deadline=meets_deadline,
        reason_code=code,
        reason=reason,
        receiving_slot=receive,
    )

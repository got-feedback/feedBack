"""Cosmetics shop (spec 010) — buy/equip avatars & themes with earned currency.

Extracted verbatim from ``server.py`` (R3); edits: ``@app`` -> ``@router``,
``meta_db`` -> ``appstate.meta_db``, ``_get_progression_content()`` ->
``appstate.get_progression_content()`` (the accessor is injected into the seam;
its lazy content cache stays in server.py).
"""

from fastapi import APIRouter
from fastapi.responses import JSONResponse

import appstate
from reqfields import _clean_str

router = APIRouter()


@router.get("/api/shop")
def api_shop():
    content = appstate.get_progression_content()
    owned = appstate.meta_db.get_owned_items()
    equipped = appstate.meta_db.get_equipped()
    items = [
        {**item, "owned": iid in owned, "equipped": equipped.get(item["slot"]) == iid}
        for iid, item in sorted(content["shop"].items())
    ]
    return {"items": items, "wallet": appstate.meta_db.get_wallet()}


@router.post("/api/shop/buy")
def api_shop_buy(data: dict):
    """Spend Decibels on a cosmetic. Atomic: balance check + spend + ownership
    in one transaction. Decibels are earned by playing only — never purchasable."""
    item_id = _clean_str(data.get("item_id"))
    item = appstate.get_progression_content()["shop"].get(item_id)
    if not item:
        return JSONResponse({"error": f"unknown item: {item_id!r}"}, status_code=400)
    status, wallet = appstate.meta_db.buy_shop_item(item)
    if status == "owned":
        return JSONResponse({"error": "already owned", "wallet": wallet}, status_code=409)
    if status == "insufficient":
        return JSONResponse({"error": "insufficient balance", "wallet": wallet}, status_code=402)
    return {"ok": True, "item_id": item_id, "wallet": wallet}


@router.post("/api/shop/equip")
def api_shop_equip(data: dict):
    """Equip an owned cosmetic into its slot. Body: {slot, item_id|null}
    (null unequips, restoring the default look)."""
    import progression as progression_mod
    slot = _clean_str(data.get("slot"))
    if slot not in progression_mod.SHOP_SLOTS:
        return JSONResponse({"error": f"slot must be one of {sorted(progression_mod.SHOP_SLOTS)}"}, status_code=400)
    item_id = data.get("item_id")
    if item_id is not None:
        item_id = _clean_str(item_id)
        item = appstate.get_progression_content()["shop"].get(item_id)
        if not item or item["slot"] != slot:
            return JSONResponse({"error": f"unknown item for slot {slot}: {item_id!r}"}, status_code=400)
        if item_id not in appstate.meta_db.get_owned_items():
            return JSONResponse({"error": "item not owned"}, status_code=403)
    return {"ok": True, "equipped": appstate.meta_db.equip_item(slot, item_id)}

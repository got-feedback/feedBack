from fastapi import APIRouter
import appstate

router = APIRouter()


@router.get("/api/instruments")
def get_instruments():
    reg = getattr(appstate, "instrument_registry", None)
    return reg.get_all() if reg else []

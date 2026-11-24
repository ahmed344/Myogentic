import csv
import io
import json
import logging
from hashlib import sha256
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from typing import Annotated

import openslide
from fastapi import FastAPI, HTTPException, Query, Request
from fastapi.responses import JSONResponse, Response
from fastapi.staticfiles import StaticFiles
from starlette.middleware.trustedhost import TrustedHostMiddleware

from .config import ROOT, Settings, load_settings
from .models import DEFINITIONS, DEFINITION_VERSIONS, Kind, SaveRequest
from .slides import SlidePool, jpeg
from .tiff import TiffSlide
from .storage import Conflict, Store

Reviewer = Annotated[str, Query(min_length=1, max_length=80, pattern=r"^[\w .@+-]+$")]


def create_app(settings: Settings | None = None):
    settings = settings or load_settings()
    store = Store(settings)
    pool = SlidePool(thumbnail_cache=settings.database.parent / "thumbnail-cache")

    @asynccontextmanager
    async def lifespan(app):
        app.state.scan = store.scan()
        yield
        pool.close()

    app = FastAPI(title="Myogentic Annotator", version="0.1.0", lifespan=lifespan)
    app.state.store = store
    app.state.pool = pool
    app.state.scan = {"indexed": 0, "warnings": []}
    app.add_middleware(TrustedHostMiddleware, allowed_hosts=["localhost", "127.0.0.1", "[::1]", "testserver"])

    @app.middleware("http")
    async def local_writes(request: Request, call_next):
        # JSON plus a custom header keeps unrelated websites from posting to localhost.
        if request.method in {"POST", "PUT", "DELETE", "PATCH"} and request.headers.get("x-myogentic-client") != "annotator":
            return JSONResponse({"detail": "Missing local application header"}, status_code=403)
        response = await call_next(request)
        if request.url.path.startswith("/api/"):
            response.headers.setdefault("Cache-Control", "no-store")
        response.headers["X-Content-Type-Options"] = "nosniff"
        return response

    @app.exception_handler(OSError)
    async def missing(request, exc):
        logging.getLogger("myogentic.slides").warning("Slide access failed for %s: %s", request.url.path, exc)
        return JSONResponse({"detail": "Slide unavailable. Check the drive connection and refresh the library."}, status_code=404)

    @app.exception_handler(Conflict)
    async def conflict(request, exc):
        return JSONResponse({"detail": str(exc)}, status_code=409)

    @app.exception_handler(openslide.OpenSlideError)
    async def slide_error(request, exc):
        logging.getLogger("myogentic.slides").warning("Slide read failed for %s: %s", request.url.path, exc)
        # Native readers can include patient filenames in their exceptions.
        safe_messages = {
            "This TIFF contains multiple pages; select or convert the intended image first.",
            "The TIFF reader currently supports single-page, 8-bit RGB/RGBA images.",
        }
        message = str(exc) if str(exc) in safe_messages else "The image reader could not open this slide. Check the drive connection and image format."
        return JSONResponse({"detail": message}, status_code=422)

    def public_scan():
        return {"indexed": app.state.scan["indexed"],
                "warnings": ["Some slides could not be indexed. Check the configured drives and refresh the library."] if app.state.scan["warnings"] else []}

    def require_slide(slide_id):
        slide = store.slide(slide_id)
        if not slide:
            raise HTTPException(404, "Unknown slide")
        return slide

    @app.get("/api/health")
    def health():
        return {"status": "ok", "schema_version": DEFINITIONS["version"]}

    @app.get("/api/config")
    def configuration():
        return {"definitions": DEFINITIONS, "definition_versions": DEFINITION_VERSIONS, "scan": public_scan()}

    @app.post("/api/rescan")
    def rescan():
        app.state.scan = store.scan()
        pool.close()
        return public_scan()

    @app.get("/api/slides")
    def slides(reviewer: Reviewer, kind: Kind = "individual"):
        return store.list_slides(reviewer.strip(), kind)

    @app.get("/api/slides/{slide_id}/info")
    def slide_info(slide_id: str):
        with pool.open(store.path(slide_id)) as (slide, _, _):
            return {"width": slide.dimensions[0], "height": slide.dimensions[1], "levels": slide.level_count,
                    "mpp": slide.properties.get(openslide.PROPERTY_NAME_MPP_X),
                    "mpp_y": slide.properties.get(openslide.PROPERTY_NAME_MPP_Y),
                    "calibration_source": slide.properties.get("myogentic.calibration-source", "OpenSlide") if slide.properties.get(openslide.PROPERTY_NAME_MPP_X) else None,
                    "objective": slide.properties.get(openslide.PROPERTY_NAME_OBJECTIVE_POWER)}

    @app.get("/api/slides/{slide_id}/thumbnail")
    def thumbnail(slide_id: str):
        with pool.open(store.path(slide_id)) as (slide, _, transform):
            if isinstance(slide, TiffSlide):
                preview = slide.cached_thumbnail()
                if preview is None:
                    # Defer expensive TIFF overview reads until the slide is
                    # selected. Listing 29 TIFFs must not scan all 59 GB of pixels.
                    return Response('<svg xmlns="http://www.w3.org/2000/svg" width="240" height="160" viewBox="0 0 240 160"><rect width="240" height="160" fill="#182235"/><path d="M92 49h56v62H92z M102 65h36 M102 78h36 M102 91h22" fill="none" stroke="#93a6c5" stroke-width="3"/></svg>', media_type="image/svg+xml")
                return Response(jpeg(preview, transform), media_type="image/jpeg")
            return Response(jpeg(slide.get_thumbnail((240, 160)), transform), media_type="image/jpeg")

    @app.get("/api/slides/{slide_id}/dzi.dzi")
    def dzi(slide_id: str):
        with pool.open(store.path(slide_id)) as (_, zoom, _):
            return Response(zoom.get_dzi("jpeg"), media_type="application/xml")

    @app.get("/api/slides/{slide_id}/dzi_files/{level}/{col}_{row}.jpeg")
    def tile(slide_id: str, level: int, col: int, row: int, request: Request):
        # Resolve and validate the source even on a cache hit: changed or
        # disconnected files must not silently serve stale evidence pixels.
        path = store.path(slide_id)
        try:
            data = pool.tile(path, level, col, row)
        except ValueError as exc:
            raise HTTPException(404, "Invalid tile level or coordinates") from exc
        etag = f'"{sha256(data).hexdigest()}"'
        # Private browser caching saves repeat transfers, but always revalidate
        # against the local file. Assessments and other API data remain no-store.
        headers = {"Cache-Control": "private, no-cache", "ETag": etag}
        validators = [value.strip().removeprefix("W/") for value in request.headers.get("if-none-match", "").split(",")]
        if etag in validators or "*" in validators:
            return Response(status_code=304, headers=headers)
        return Response(data, media_type="image/jpeg", headers=headers)

    @app.get("/api/slides/{slide_id}/assessment")
    def get_assessment(slide_id: str, reviewer: Reviewer, kind: Kind = "individual"):
        require_slide(slide_id)
        return store.assessment(slide_id, reviewer.strip(), kind)

    @app.put("/api/slides/{slide_id}/assessment")
    def save_assessment(slide_id: str, reviewer: Reviewer, request: SaveRequest, kind: Kind = "individual"):
        require_slide(slide_id)
        path = store.path(slide_id)
        if not reviewer.strip():
            raise HTTPException(422, "Reviewer name is required")
        if request.assessment.regions:
            with pool.open(path) as (slide, _, _):
                width, height = slide.dimensions
                if any(not region.fits_slide(width, height) for region in request.assessment.regions):
                    raise HTTPException(422, "Evidence geometry exceeds the original slide bounds")
        return store.save(slide_id, reviewer.strip(), kind, request.expected_revision, request.assessment)

    @app.get("/api/slides/{slide_id}/history")
    def history(slide_id: str, reviewer: Reviewer, kind: Kind = "individual"):
        require_slide(slide_id)
        return store.history(slide_id, reviewer.strip(), kind)

    @app.get("/api/export.json")
    def export_json():
        payload = {"format": "myogentic-annotations", "exported_at": datetime.now(timezone.utc).isoformat(),
                   "definitions": DEFINITIONS, "definition_versions": DEFINITION_VERSIONS,
                   "identity": "hashed-slide-ids", **store.blinded_export()}
        return Response(json.dumps(payload, indent=2), media_type="application/json",
                        headers={"Content-Disposition": 'attachment; filename="myogentic-annotations.json"'})

    @app.get("/api/export.csv")
    def export_csv():
        data = store.blinded_export()
        names = {s["id"]: s for s in data["slides"]}
        latest = {(r["slide_id"], r["reviewer"], r["kind"]): r for r in data["revisions"]}
        output = io.StringIO()
        columns = ["slide_id", "slide_name", "reviewer", "kind", "revision", "saved_at", "schema_version",
                   "status", "overall", "extent", "certainty", "dominant", "comments", "patterns_json", "findings_json", "finding_grades_json", "legacy_findings_json", "regions_json", "finding_types_json"]
        writer = csv.DictWriter(output, fieldnames=columns)
        writer.writeheader()
        def safe_cell(value):
            # Keep exported comments/names from executing as spreadsheet formulas.
            return "'" + value if isinstance(value, str) and value.lstrip().startswith(("=", "+", "-", "@", "\t", "\r")) else value
        for r in latest.values():
            doc = r["assessment"]
            row = {k: r[k] for k in ("slide_id", "reviewer", "kind", "revision", "saved_at")}
            row["slide_name"] = names[r["slide_id"]]["name"]
            row.update({k: doc[k] for k in ("schema_version", "status", "overall", "extent", "certainty", "dominant", "comments")})
            row.update({f"{k}_json": json.dumps(doc[k]) for k in ("patterns", "findings", "regions")})
            row.update({f"{k}_json": json.dumps(doc.get(k)) for k in ("finding_grades", "legacy_findings", "finding_types")})
            writer.writerow({k: safe_cell(v) for k, v in row.items()})
        return Response(output.getvalue(), media_type="text/csv", headers={"Content-Disposition": 'attachment; filename="myogentic-summary.csv"'})

    static = ROOT / "frontend/dist"
    if static.exists():
        app.mount("/", StaticFiles(directory=static, html=True), name="frontend")
    return app

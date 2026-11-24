import csv
import io
import json
from contextlib import contextmanager

import openslide
import pytest
from fastapi.testclient import TestClient
from PIL import Image

from backend.app import create_app
from backend.config import Settings, Source
from backend.models import Assessment, AssessmentV2, AssessmentV3, LegacyAssessment
from backend.storage import Store

HEADERS = {"X-Myogentic-Client": "annotator"}


@pytest.fixture
def workspace(tmp_path):
    root = tmp_path / "slides"
    root.mkdir()
    Image.new("RGB", (1024, 768), "pink").save(root / "sample.tif")
    settings = Settings(tmp_path / "data/annotations.sqlite3", (Source("test", "Test slides", root),))
    app = create_app(settings)
    # Exercise the actual stripped-TIFF fallback, not a substituted image reader.
    with TestClient(app) as client:
        slides = client.get("/api/slides", params={"reviewer": "Doctor A"}).json()
        yield client, slides[0]["id"], settings


def endpoint(slide_id, suffix="assessment", reviewer="Doctor A", kind="individual"):
    return f"/api/slides/{slide_id}/{suffix}?reviewer={reviewer}&kind={kind}"


def save(client, slide_id, doc, revision=0, reviewer="Doctor A", kind="individual"):
    return client.put(endpoint(slide_id, reviewer=reviewer, kind=kind), headers=HEADERS,
                      json={"expected_revision": revision, "assessment": doc})


def test_unanswered_fields_and_completion(workspace):
    client, sid, _ = workspace
    initial = client.get(endpoint(sid)).json()
    assert initial["revision"] == 0
    doc = initial["assessment"]
    assert doc["overall"] == "unassessed"
    assert set(doc["findings"].values()) == {"unassessed"}
    assert all(p["presence"] == "unassessed" for p in doc["patterns"].values())
    assert doc["certainty"] == "high"
    assert all(p["certainty"] == "high" for p in doc["patterns"].values())
    doc["status"] = "complete"
    assert save(client, sid, doc).status_code == 422
    doc["overall"] = "not_assessable"
    assert save(client, sid, doc).status_code == 422
    doc["dominant"] = "not_assessable"
    assert save(client, sid, doc).status_code == 200


def test_independent_reviewers_revisions_and_adjudication(workspace):
    client, sid, settings = workspace
    doc = Assessment().model_dump()
    doc["patterns"]["myopathic"]["presence"] = "present"
    doc["patterns"]["inflammatory"]["presence"] = "present"
    doc["patterns"]["inflammatory"]["certainty"] = "low"
    assert save(client, sid, doc).json()["revision"] == 1
    doc["comments"] = "Second observation"
    assert save(client, sid, doc, 1).json()["revision"] == 2
    assert save(client, sid, Assessment().model_dump(), reviewer="Doctor B").json()["revision"] == 1
    assert save(client, sid, Assessment().model_dump(), kind="adjudicated").json()["revision"] == 1
    history = client.get(endpoint(sid, "history")).json()
    assert len(history) == 2
    assert history[1]["assessment"]["comments"] == ""
    assert history[0]["assessment"]["comments"] == "Second observation"
    assert Store(settings).assessment(sid, "Doctor A", "individual")["assessment"] == doc
    exported = client.get("/api/export.json").json()
    assert len(exported["revisions"]) == 4
    assert exported["definitions"]["version"] == "4.3"
    assert exported["revisions"][0]["slide_fingerprint"]["size"] > 0


def test_stale_tab_cannot_overwrite(workspace):
    client, sid, _ = workspace
    doc = Assessment().model_dump()
    doc["comments"] = "Must be retained"
    assert save(client, sid, doc).status_code == 200
    doc["comments"] = "Stale tab"
    assert save(client, sid, doc).status_code == 409
    assert client.get(endpoint(sid)).json()["assessment"]["comments"] == "Must be retained"


def test_regions_roundtrip_and_reject_invalid_geometry(workspace):
    client, sid, _ = workspace
    doc = Assessment().model_dump()
    region = {"id": "r1", "x": 120.5, "y": 200, "width": 400, "height": 300, "label": "Visible evidence"}
    doc["regions"] = [region]
    assert save(client, sid, doc).status_code == 200
    assert client.get(endpoint(sid)).json()["assessment"]["regions"] == [region]
    doc["regions"][0]["width"] = 1024
    assert save(client, sid, doc, 1).status_code == 422
    doc["regions"][0]["width"] = -1
    assert save(client, sid, doc, 1).status_code == 422


def test_brush_redraw_and_legacy_rectangle_roundtrip(workspace):
    client, sid, _ = workspace
    rectangle = dict(id='old', label='Earlier note', x=10, y=20, width=30, height=25)
    old = Assessment(schema_version='4.1').model_dump()
    old['regions'] = [rectangle]
    assert save(client, sid, old).status_code == 200
    brush = dict(id='mark', label='Freehand evidence', shape='brush', diameter=9.5,
                 points=[[0, 0], [31.5, 27], [40, 13], [61, 40]])
    current = {**old, 'schema_version': '4.2', 'regions': [rectangle, brush]}
    assert save(client, sid, current, 1).status_code == 200
    assert client.get(endpoint(sid)).json()['assessment']['regions'] == [rectangle, brush]
    revised = {**brush, 'diameter': 3, 'points': [[1024, 768]]}
    edited = {**current, 'regions': [rectangle, revised]}
    assert save(client, sid, edited, 2).status_code == 200
    assert [r['assessment'] for r in client.get(endpoint(sid, 'history')).json()] == [edited, current, old]
    assert client.get('/api/export.json').json()['revisions'][-1]['assessment']['regions'] == edited['regions']
    row = next(csv.DictReader(io.StringIO(client.get('/api/export.csv').text)))
    assert json.loads(row['regions_json']) == edited['regions']
    assert save(client, sid, {**old, 'regions': [brush]}, 3).status_code == 422


@pytest.mark.parametrize('patch', [
    {'points': []}, {'points': [[-1, 2]]}, {'points': [[10, 769]]}, {'points': [[1, 2, 3]]},
    {'points': [[1, 1]] * 8193}, {'diameter': 0}, {'diameter': 1e10},
])
def test_brush_rejects_invalid_geometry(workspace, patch):
    client, sid, _ = workspace
    region = dict(id='brush', label='', shape='brush', diameter=3, points=[[100, 100]])
    doc = Assessment().model_dump()
    doc['regions'] = [{**region, **patch}]
    assert save(client, sid, doc).status_code == 422
    assert client.get(endpoint(sid)).json()['revision'] == 0


def test_revise_compound_region_with_fill_and_erase(workspace):
    client, sid, _ = workspace
    old_brush = dict(shape='brush', id='r1', label='Area A', diameter=4, points=[[40, 40]])
    old = {**Assessment(schema_version='4.2').model_dump(), 'regions': [old_brush]}
    assert save(client, sid, old).status_code == 200
    strokes = [
        dict(mode='paint', diameter=4, points=[[40, 40]]),
        dict(mode='outline', diameter=6, points=[[50, 60], [90, 100], [90, 60]]),
        dict(mode='erase', diameter=4, points=[[90, 60]]),
    ]
    region = dict(id='r1', label='Area A', shape='compound', base=None, strokes=strokes)
    current = {**old, 'schema_version': '4.3', 'regions': [region]}
    assert save(client, sid, current, 1).status_code == 200
    filled = {**region, 'strokes': [strokes[0], {**strokes[1], 'mode': 'fill'}, strokes[2]]}
    finished = {**current, 'regions': [filled]}
    assert save(client, sid, finished, 2).status_code == 200
    assert client.get(endpoint(sid)).json()['assessment'] == finished
    assert [r['assessment'] for r in client.get(endpoint(sid, 'history')).json()] == [finished, current, old]
    assert client.get('/api/export.json').json()['revisions'][-1]['assessment'] == finished
    row = next(csv.DictReader(io.StringIO(client.get('/api/export.csv').text)))
    assert json.loads(row['regions_json']) == [filled]
    assert save(client, sid, {**finished, 'schema_version': '4.2'}, 3).status_code == 422


def test_compound_geometry_requires_valid_strokes_and_checks_slide_bounds(workspace):
    client, sid, _ = workspace
    mark = dict(mode='paint', points=[[5, 5]], diameter=4)
    erase = {**mark, 'mode': 'erase'}
    base = dict(x=1, y=2, width=10, height=20)
    region = dict(id='r', label='Original rectangle', shape='compound', base=base, strokes=[erase])
    doc = {**Assessment().model_dump(), 'regions': [region]}
    assert save(client, sid, doc).status_code == 200
    for patch in [
        dict(base=None), dict(base={**base, 'width': 1025}), dict(strokes=[]),
        dict(strokes=[mark] * 513), dict(strokes=[mark, {**erase, 'points': [[1025, 0]]}]),
        dict(strokes=[{**mark, 'mode': 'fill', 'points': [[2, 2], [2, 2], [3, 3], [4, 4]]}]),
    ]:
        assert save(client, sid, {**doc, 'regions': [{**region, **patch}]}, 1).status_code == 422
    assert client.get(endpoint(sid)).json()['assessment'] == doc


def test_deepzoom_metadata_tiles_and_bounds(workspace):
    client, sid, _ = workspace
    # Listing an unopened TIFF must not trigger full-image overview decoding.
    placeholder = client.get(f"/api/slides/{sid}/thumbnail")
    assert placeholder.headers["content-type"] == "image/svg+xml"
    info = client.get(f"/api/slides/{sid}/info").json()
    assert (info["width"], info["height"]) == (1024, 768)
    dzi = client.get(f"/api/slides/{sid}/dzi.dzi")
    assert dzi.status_code == 200
    assert 'Width="1024"' in dzi.text and 'Overlap="1"' in dzi.text
    tile = client.get(f"/api/slides/{sid}/dzi_files/10/0_0.jpeg")
    assert tile.status_code == 200 and tile.content.startswith(b"\xff\xd8")
    assert client.get(f"/api/slides/{sid}/dzi_files/99/0_0.jpeg").status_code == 404
    assert client.get(f"/api/slides/{sid}/dzi_files/10/-1_0.jpeg").status_code == 404
    assert client.get(f"/api/slides/{sid}/thumbnail").status_code == 200


def test_tiff_thumbnail_is_cached_only_after_viewing(workspace):
    client, sid, settings = workspace
    assert client.get(f"/api/slides/{sid}/thumbnail").headers["content-type"] == "image/svg+xml"
    assert not (settings.database.parent / "thumbnail-cache").exists()
    assert client.get(f"/api/slides/{sid}/dzi_files/8/0_0.jpeg").status_code == 200
    client.app.state.pool.close()
    # A newly opened reader reuses the tiny preview without decoding the TIFF.
    assert client.get(f"/api/slides/{sid}/thumbnail").headers["content-type"] == "image/jpeg"
    assert len(list((settings.database.parent / "thumbnail-cache").glob("*.png"))) == 1


def test_tiles_revalidate_browser_cache_and_reject_changed_or_missing_files(workspace, monkeypatch):
    client, sid, settings = workspace
    url = f"/api/slides/{sid}/dzi_files/10/0_0.jpeg"
    first = client.get(url)
    assert first.status_code == 200
    assert first.headers["cache-control"] == "private, no-cache"
    etag = first.headers["etag"]
    # A repeated transfer and a browser revalidation both skip decoding.
    with client.app.state.pool.open(settings.sources[0].path / "sample.tif") as (_, zoom, _):
        monkeypatch.setattr(zoom, "get_tile", lambda *args: pytest.fail("Tile decoded twice"))
    assert client.get(url).content == first.content
    cached = client.get(url, headers={"If-None-Match": f'"other", W/{etag}'})
    assert cached.status_code == 304 and not cached.content
    assert cached.headers["etag"] == etag
    assert client.get(endpoint(sid)).headers["cache-control"] == "no-store"
    assert client.get(f"/api/slides/{sid}/dzi_files/99/0_0.jpeg").headers["cache-control"] == "no-store"
    path = settings.sources[0].path / "sample.tif"
    Image.new("RGB", (1025, 768), "blue").save(path)
    assert client.get(url, headers={"If-None-Match": etag}).status_code == 409
    assert client.post("/api/rescan", headers=HEADERS).status_code == 200
    changed = client.get(url, headers={"If-None-Match": etag})
    assert changed.status_code == 200
    assert changed.headers["etag"] != etag and changed.content != first.content
    path.unlink()
    assert client.get(url, headers={"If-None-Match": changed.headers["etag"]}).status_code == 404


def test_disconnected_drive_retains_reviews_and_exports(workspace):
    client, sid, settings = workspace
    doc = Assessment().model_dump()
    assert save(client, sid, doc).status_code == 200
    path = settings.sources[0].path / "sample.tif"
    path.rename(path.with_suffix(".disconnected"))
    assert client.post("/api/rescan", headers=HEADERS).status_code == 200
    result = client.get("/api/slides?reviewer=Doctor A").json()
    assert result[0]["available"] == 0
    assert result[0]["status"] == "in_progress"
    assert client.get(endpoint(sid)).json()["revision"] == 1
    assert save(client, sid, doc, 1).status_code == 404
    assert len(client.get("/api/export.json").json()["revisions"]) == 1


def test_source_path_move_preserves_slide_identity(workspace, tmp_path):
    client, sid, settings = workspace
    assert save(client, sid, Assessment().model_dump()).status_code == 200
    moved = tmp_path / "moved"
    settings.sources[0].path.rename(moved)
    store = Store(Settings(settings.database, (Source("test", "Moved slides", moved),)))
    store.scan()
    assert store.list_slides("Doctor A", "individual")[0]["id"] == sid
    assert store.assessment(sid, "Doctor A", "individual")["revision"] == 1


def test_no_outside_files_and_changed_slide_rejected(workspace, tmp_path):
    client, sid, settings = workspace
    outside = tmp_path / "outside.tif"
    outside.write_bytes(b"outside")
    (settings.sources[0].path / "link.tif").symlink_to(outside)
    assert client.post("/api/rescan", headers=HEADERS).json()["indexed"] == 1
    with (settings.sources[0].path / "sample.tif").open("ab") as output:
        output.write(b"changed")
    assert save(client, sid, Assessment().model_dump()).status_code == 409
    assert client.get("/api/slides/not-a-slide/assessment?reviewer=A").status_code == 404


def test_local_request_guard_and_csv_preserves_unknowns(workspace):
    client, sid, _ = workspace
    assert client.post("/api/rescan").status_code == 403
    assert client.get("/api/health", headers={"Host": "untrusted.example"}).status_code == 400
    doc = Assessment().model_dump()
    doc["comments"] = '=HYPERLINK("https://example.invalid")'
    assert save(client, sid, doc).status_code == 200
    assert "unassessed" in client.get("/api/export.csv").text
    assert "'=HYPERLINK" in client.get("/api/export.csv").text
    assert client.get("/api/export.json").json()["revisions"][0]["assessment"]["comments"].startswith('=HYPERLINK')


def test_schema_is_strict_and_retains_uncertainty(workspace):
    client, sid, _ = workspace
    doc = Assessment().model_dump()
    doc["patterns"]["myopathic"] = {"presence": "uncertain", "severity": "marked", "certainty": "low"}
    assert save(client, sid, doc).status_code == 200
    doc["findings"]["unknown_finding"] = "present"
    assert save(client, sid, doc, 1).status_code == 422


def test_legacy_confidence_and_revision_definitions_are_preserved(workspace):
    client, sid, _ = workspace
    legacy = LegacyAssessment(schema_version="1.0").model_dump()
    legacy["certainty"] = "unassessed"
    legacy["patterns"]["myopathic"]["certainty"] = "low"
    legacy["patterns"]["neurogenic"]["certainty"] = "unassessed"
    assert save(client, sid, legacy).status_code == 200
    assert client.get(endpoint(sid)).json()["assessment"] == legacy
    current = LegacyAssessment(**legacy).model_copy(deep=True)
    current.schema_version = "1.1"
    current.certainty = "high"
    current.patterns["neurogenic"].certainty = "high"
    assert save(client, sid, current.model_dump(), 1).status_code == 200
    history = client.get(endpoint(sid, "history")).json()
    assert history[1]["assessment"] == legacy
    assert history[0]["assessment"]["patterns"]["myopathic"]["certainty"] == "low"
    export = client.get("/api/export.json").json()
    assert set(export["definition_versions"]) == {"1.0", "1.1", "2.0", "3.0", "4.0", "4.1", "4.2", "4.3"}
    assert "unassessed" in export["definition_versions"]["1.0"]["certainty"]
    assert export["definitions"]["certainty"] == ["low", "moderate", "high"]


def test_current_confidence_requires_a_slider_value(workspace):
    client, sid, _ = workspace
    for value in ["low", "moderate", "high"]:
        doc = Assessment(certainty=value).model_dump()
        assert save(client, sid, doc, ["low", "moderate", "high"].index(value)).status_code == 200
    doc["certainty"] = "unassessed"
    assert save(client, sid, doc, 3).status_code == 422
    doc["certainty"] = "high"
    doc["patterns"]["myopathic"]["certainty"] = "unassessed"
    assert save(client, sid, doc, 3).status_code == 422


def test_browser_payloads_and_exports_hide_original_identity(workspace):
    client, sid, settings = workspace
    assert save(client, sid, Assessment().model_dump()).status_code == 200
    slides = client.get('/api/slides?reviewer=Doctor A').json()
    assert slides[0]['name'] == f'SL-{sid.upper()}'
    assert set(slides[0]) == {'id', 'name', 'available', 'revision', 'saved_at', 'status'}
    config = client.get('/api/config').json()
    assert set(config) == {'definitions', 'definition_versions', 'scan'}
    assert config['definition_versions'] == client.get('/api/export.json').json()['definition_versions']
    exported = client.get('/api/export.json').json()
    assert 'sources' not in exported
    assert exported['slides'][0] == {'id': sid, 'name': slides[0]['name'], 'available': 1}
    assert set(exported['revisions'][0]['slide_fingerprint']) == {'size', 'modified_ns'}
    summary = client.get('/api/export.csv').text
    row = next(csv.DictReader(io.StringIO(summary)))
    assert row['slide_name'] == slides[0]['name'] and row['slide_id'] == sid
    assert 'source' not in row and 'relative_path' not in row
    for response in (str(slides), str(config), str(exported), summary):
        assert 'sample.tif' not in response
        assert 'Test slides' not in response
        assert str(settings.sources[0].path) not in response
    # The on-disk archive still carries the original mapping and provenance.
    original = Store(settings).export()
    assert original['slides'][0]['name'] == 'sample.tif'
    assert original['revisions'][0]['slide_fingerprint']['relative_path'] == 'sample.tif'


def test_scan_and_native_reader_errors_do_not_expose_names(workspace, monkeypatch):
    client, sid, settings = workspace
    for error in (openslide.OpenSlideError('Patient-123 Diagnosis-X /secret/site/image.tif'),
                  FileNotFoundError('/secret/site/Patient-123.tif'),
                  PermissionError('/secret/site/Patient-123.tif')):
        @contextmanager
        def broken_reader(*args):
            raise error
            yield

        monkeypatch.setattr(client.app.state.pool, 'open', broken_reader)
        response = client.get(f'/api/slides/{sid}/info')
        assert response.status_code in (404, 422)
        assert 'Patient-123' not in response.text and '/secret' not in response.text
    settings.sources[0].path.rename(settings.sources[0].path.with_name('disconnected'))
    for scan in (client.post('/api/rescan', headers=HEADERS).json(), client.get('/api/config').json()['scan']):
        assert scan['warnings']
        assert 'Test slides' not in str(scan)


def test_shuffled_order_is_stable_and_preserves_existing_annotations(tmp_path):
    sources = []
    for site in range(4):
        root = tmp_path / f'site-{site}'
        root.mkdir()
        for patient in range(10):
            for section in range(2):
                (root / f'Diagnosis-patient-{patient:02}-{section}.tif').touch()
        sources.append(Source(f'site-{site}', f'Clinic {site}', root))
    settings = Settings(tmp_path / 'annotations.sqlite3', tuple(sources))
    store = Store(settings)
    store.scan()
    original = {s['id']: s for s in store.export()['slides']}
    listed = store.list_slides('Doctor A', 'individual')
    order = [s['id'] for s in listed]
    assert len(set(s['name'] for s in listed)) == len(listed) == 80
    sites = [original[sid]['source'] for sid in order]
    # A representative collection must be mixed instead of four filename blocks.
    assert sum(a != b for a, b in zip(sites, sites[1:])) > 40
    sid = order[4]
    doc = Assessment(comments='Retain this existing assessment')
    store.save(sid, 'Doctor A', 'individual', 0, doc)
    assert [s['id'] for s in store.list_slides('Doctor A', 'individual')] == order
    assert [s['id'] for s in store.list_slides('Doctor B', 'adjudicated')] == order
    store = Store(settings)
    store.scan()
    assert [s['id'] for s in store.list_slides('Doctor A', 'individual')] == order
    (sources[0].path / 'new-patient.tif').touch()
    store.scan()
    added = store.list_slides('Doctor A', 'individual')
    assert [s['id'] for s in added if s['id'] in original] == order
    assert store.assessment(sid, 'Doctor A', 'individual')['assessment'] == doc.model_dump()


@pytest.mark.parametrize('dominant', ['myopathic', 'dystrophic', 'inflammatory', 'neurogenic', 'mixed', 'no_dominant_pattern', 'uncertain', 'not_assessable'])
def test_main_pattern_is_an_explicit_completion_choice(workspace, dominant):
    client, sid, _ = workspace
    doc = Assessment(overall='uncertain').model_dump()
    # Incomplete drafts must still autosave.
    assert save(client, sid, doc).status_code == 200
    doc['status'] = 'complete'
    assert save(client, sid, doc, 1).status_code == 422
    doc['dominant'] = dominant
    assert save(client, sid, doc, 1).status_code == 200
    assert client.get(endpoint(sid)).json()['assessment']['dominant'] == dominant


def test_separate_findings_and_grades_round_trip_and_export(workspace):
    client, sid, _ = workspace
    doc = Assessment().model_dump()
    assert set(doc['finding_grades'].values()) == {'unassessed'}
    assert set(doc['findings']) == set(doc['finding_grades'])
    assert not {'nuclear_alterations', 'internal_nuclei', 'inflammatory_infiltrate', 'necrosis_regeneration', 'grouped_atrophy', 'atrophy'} & doc['findings'].keys()
    independent = {
        'internal_nuclei_noncentered': ('present', 'grade_1'), 'centered_nuclei': ('uncertain', 'grade_2'),
        'perimysial': ('present', 'grade_3'), 'endomysial': ('present', 'grade_1'), 'perivascular': ('absent', 'not_applicable'),
        'necrosis': ('present', 'grade_3'), 'regeneration': ('present', 'grade_1'),
        'rounded_atrophy': ('present', 'grade_2'), 'angular_atrophy': ('uncertain', 'grade_1'),
        'perifascicular_atrophy': ('present', 'grade_3'),
    }
    for finding, (presence, grade) in independent.items():
        doc['findings'][finding] = presence
        doc['finding_grades'][finding] = grade
    assert save(client, sid, doc).status_code == 200
    assert client.get(endpoint(sid)).json()['assessment'] == doc
    assert client.get(endpoint(sid, 'history')).json()[0]['assessment'] == doc
    exported = client.get('/api/export.json').json()
    assert exported['revisions'][0]['assessment'] == doc
    row = next(csv.DictReader(io.StringIO(client.get('/api/export.csv').text)))
    assert json.loads(row['findings_json']) == doc['findings']
    assert json.loads(row['finding_grades_json']) == doc['finding_grades']
    groups = {f['label']: [t['id'] for t in f['types']] for f in exported['definitions']['findings'] if 'types' in f}
    assert groups == {'Nuclear alterations': ['internal_nuclei_noncentered', 'centered_nuclei'],
                      'Inflammatory cells': ['perimysial', 'endomysial', 'perivascular'],
                      'Atrophy': ['rounded_atrophy', 'angular_atrophy', 'perifascicular_atrophy']}
    for id in independent:
        invalid = {**doc, 'findings': {**doc['findings'], id: 'absent'},
                   'finding_grades': {**doc['finding_grades'], id: 'grade_3'}}
        assert save(client, sid, invalid, 1).status_code == 422


def test_v4_atrophy_reviews_survive_regrouping(workspace):
    client, sid, _ = workspace
    old = Assessment(schema_version='4.0').model_dump()
    old['findings'].update(rounded_atrophy='present', angular_atrophy='uncertain', perifascicular_atrophy='absent')
    old['finding_grades'].update(rounded_atrophy='grade_3', angular_atrophy='grade_1', perifascicular_atrophy='not_applicable')
    assert save(client, sid, old).status_code == 200
    current = {**old, 'schema_version': '4.1', 'finding_grades': {**old['finding_grades'], 'angular_atrophy': 'grade_2'}}
    assert save(client, sid, current, 1).status_code == 200
    assert [r['assessment'] for r in client.get(endpoint(sid, 'history')).json()] == [current, old]


@pytest.mark.parametrize(('presence', 'types'), [
    ('present', ['centered_nuclei', 'centered_nuclei']), ('uncertain', ['endomysial']),
    ('absent', ['centered_nuclei']), ('not_assessable', ['centered_nuclei']), ('unassessed', ['centered_nuclei']),
])
def test_invalid_v3_finding_types(workspace, presence, types):
    client, sid, _ = workspace
    doc = AssessmentV3().model_dump()
    doc['findings']['internal_nuclei'] = presence
    doc['finding_types']['internal_nuclei'] = types
    assert save(client, sid, doc).status_code == 422


def test_v2_nuclear_grades_and_nested_v1_snapshot_survive_new_revision(workspace):
    client, sid, _ = workspace
    original = LegacyAssessment().model_dump()
    v1 = {k: original[k] for k in ('schema_version', 'findings')}
    v2 = AssessmentV2(legacy_findings=v1).model_dump()
    for id, grade in [('internal_nuclei_noncentered', 'grade_1'), ('centered_nuclei', 'grade_3')]:
        v2['findings'][id] = 'present'
        v2['finding_grades'][id] = grade
    assert save(client, sid, v2).status_code == 200
    row = next(csv.DictReader(io.StringIO(client.get('/api/export.csv').text)))
    assert json.loads(row['finding_types_json']) is None
    snapshot = {k: v2[k] for k in ('schema_version', 'findings', 'finding_grades', 'legacy_findings')}
    current = AssessmentV3(legacy_findings=snapshot).model_dump()
    current['findings']['internal_nuclei'] = 'present'
    current['finding_types']['internal_nuclei'] = ['internal_nuclei_noncentered', 'centered_nuclei']
    assert save(client, sid, current, 1).status_code == 200
    assert save(client, sid, v2, 2).status_code == 409
    history = client.get(endpoint(sid, 'history')).json()
    assert [item['assessment'] for item in history] == [current, v2]
    row = next(csv.DictReader(io.StringIO(client.get('/api/export.csv').text)))
    assert json.loads(row['legacy_findings_json']) == snapshot

    # A v4 review retains the v3 group grades and selections as historical data.
    current['finding_grades']['internal_nuclei'] = 'grade_2'
    assert save(client, sid, current, 2).status_code == 200
    v3_snapshot = {k: current[k] for k in ('schema_version', 'findings', 'finding_grades', 'finding_types', 'legacy_findings')}
    revised = Assessment(legacy_findings=v3_snapshot).model_dump()
    revised['findings']['centered_nuclei'] = 'present'
    revised['finding_grades']['centered_nuclei'] = 'grade_3'
    assert save(client, sid, revised, 3).status_code == 200
    assert save(client, sid, current, 4).status_code == 409
    assert [r['assessment'] for r in client.get(endpoint(sid, 'history')).json()] == [revised, current, history[0]['assessment'], v2]
    row = next(csv.DictReader(io.StringIO(client.get('/api/export.csv').text)))
    assert json.loads(row['legacy_findings_json']) == v3_snapshot
    assert json.loads(row['finding_grades_json'])['centered_nuclei'] == 'grade_3'


@pytest.mark.parametrize('bad_grade', ['low', 'high', 'mild', 'grade_0', 'grade_4', 2])
def test_finding_grades_reject_confidence_and_unknown_values(workspace, bad_grade):
    client, sid, _ = workspace
    doc = Assessment().model_dump()
    doc['findings']['necrosis'] = 'present'
    doc['finding_grades']['necrosis'] = bad_grade
    assert save(client, sid, doc).status_code == 422


def test_grade_keys_and_presence_are_validated(workspace):
    client, sid, _ = workspace
    for presence in ['unassessed', 'absent', 'not_assessable']:
        doc = Assessment().model_dump()
        doc['findings']['necrosis'] = presence
        doc['finding_grades']['necrosis'] = 'grade_2'
        assert save(client, sid, doc).status_code == 422
    doc = Assessment().model_dump()
    doc['finding_grades'].pop('necrosis')
    assert save(client, sid, doc).status_code == 422
    doc = Assessment().model_dump()
    doc['findings']['necrosis_regeneration'] = 'present'
    assert save(client, sid, doc).status_code == 422
    doc = Assessment().model_dump()
    doc['dominant'] = 'none'  # In earlier versions this meant not specified.
    assert save(client, sid, doc).status_code == 422


@pytest.mark.parametrize('version', ['1.0', '1.1'])
def test_earlier_combined_findings_remain_in_history_and_migration_snapshot(workspace, version):
    client, sid, _ = workspace
    old_record = LegacyAssessment(schema_version=version, overall='uncertain')
    legacy = old_record.model_dump()
    legacy['findings']['internal_nuclei'] = 'present'
    legacy['findings']['necrosis_regeneration'] = 'uncertain'
    legacy['findings']['grouped_atrophy'] = 'present'
    # Simulate an existing completed record from before main pattern was required.
    old_record.findings = legacy['findings']
    old_record = old_record.model_copy(update={'status': 'complete'})
    legacy = old_record.model_dump()
    client.app.state.store.save(sid, 'Doctor A', 'individual', 0, old_record)
    assert client.get(endpoint(sid)).json()['assessment'] == legacy
    # An old browser cannot bypass the new completion requirement on a new save.
    assert save(client, sid, legacy, 1).status_code == 422
    updated = Assessment(legacy_findings={'schema_version': version, 'findings': legacy['findings']}).model_dump()
    assert save(client, sid, updated, 1).status_code == 200
    history = client.get(endpoint(sid, 'history')).json()
    assert history[1]['assessment'] == legacy
    assert history[0]['assessment']['legacy_findings']['findings'] == legacy['findings']
    assert set(history[0]['assessment']['findings'].values()) == {'unassessed'}
    assert set(history[0]['assessment']['finding_grades'].values()) == {'unassessed'}
    assert version in client.get('/api/export.json').json()['definition_versions']

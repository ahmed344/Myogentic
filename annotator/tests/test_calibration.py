import openslide
import pytest
from fastapi.testclient import TestClient
from PIL import Image

from backend.app import create_app
from backend.calibration import ome_calibration
from backend.config import Settings, Source


def ome(attributes='', images=None):
    pixels = f'<Image ID="Image:0"><Pixels SizeX="1024" SizeY="768" {attributes}/></Image>'
    return f'<OME xmlns="http://www.openmicroscopy.org/Schemas/OME/2015-01">{images if images is not None else pixels}</OME>'


def test_ome_default_micrometres_and_independent_axes():
    properties = ome_calibration(ome('PhysicalSizeX="0.168942" PhysicalSizeY="0.337884"'), (1024, 768))
    assert properties[openslide.PROPERTY_NAME_MPP_X] == '0.168942'
    assert properties[openslide.PROPERTY_NAME_MPP_Y] == '0.337884'


@pytest.mark.parametrize(('value', 'unit'), [('168.942', 'nm'), ('0.000168942', 'mm'), ('0.168942', 'µm')])
def test_ome_explicit_units_convert_to_micrometres(value, unit):
    properties = ome_calibration(ome(f'PhysicalSizeX="{value}" PhysicalSizeXUnit="{unit}"'), (1024, 768))
    assert float(properties[openslide.PROPERTY_NAME_MPP_X]) == pytest.approx(0.168942)
    assert openslide.PROPERTY_NAME_MPP_Y not in properties


@pytest.mark.parametrize('attributes', [
    '', 'PhysicalSizeX="0"', 'PhysicalSizeX="-1"', 'PhysicalSizeX="NaN"',
    'PhysicalSizeX="Infinity"', 'PhysicalSizeX="invalid"',
    'PhysicalSizeX="1" PhysicalSizeXUnit="pixel"',
])
def test_invalid_or_unitless_pixel_sizes_do_not_create_physical_calibration(attributes):
    assert ome_calibration(ome(attributes), (1024, 768)) == {}


def test_calibration_must_match_one_image_and_cannot_use_other_metadata():
    calibrated = ome('PhysicalSizeX="0.168942"')
    assert ome_calibration(calibrated, (2048, 1536)) == {}
    duplicate = '<Image><Pixels SizeX="1024" SizeY="768" PhysicalSizeX="0.168942"/></Image>' * 2
    assert ome_calibration(ome(images=duplicate), (1024, 768)) == {}
    assert ome_calibration(ome(images='<Instrument><Objective NominalMagnification="20"/></Instrument>'), (1024, 768)) == {}
    assert ome_calibration('<not-xml', (1024, 768)) == {}
    assert ome_calibration('<!DOCTYPE OME>' + calibrated, (1024, 768)) == {}


def test_tiff_embedded_ome_calibration_reaches_slide_info(tmp_path):
    slides = tmp_path / 'slides'
    slides.mkdir()
    Image.new('RGB', (1024, 768), 'pink').save(slides / 'sample.tif',
        tiffinfo={270: ome('PhysicalSizeX="0.168942" PhysicalSizeY="0.168942"')})
    app = create_app(Settings(tmp_path / 'annotations.sqlite3', (Source('test', 'Test slides', slides),)))
    with TestClient(app) as client:
        sid = client.get('/api/slides?reviewer=QA').json()[0]['id']
        response = client.get(f'/api/slides/{sid}/info')
        assert response.status_code == 200
        info = response.json()
        assert info['mpp'] == '0.168942'
        assert info['mpp_y'] == '0.168942'
        assert info['calibration_source'] == 'OME PhysicalSizeX/PhysicalSizeY'
        with app.state.pool.open(slides / 'sample.tif') as (slide, _, _):
            assert slide._overviews == {}  # Calibration only reads the TIFF header.

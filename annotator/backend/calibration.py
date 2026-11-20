"""Read physical pixel sizes from embedded OME metadata without decoding pixels."""

import math
import xml.etree.ElementTree as ET

import openslide

# OME PhysicalSizeX/Y default to µm when the unit attributes are absent:
# https://www.openmicroscopy.org/Schemas/Documentation/Generated/OME-2015-01/ome_xsd.html
MICRONS_PER_UNIT = {
    "m": 1_000_000, "cm": 10_000, "mm": 1_000,
    "µm": 1, "μm": 1, "um": 1, "nm": 0.001, "pm": 0.000001,
    "Å": 0.0001, "in": 25_400,
}


def ome_calibration(description: str, dimensions: tuple[int, int]) -> dict[str, str]:
    # Ignore malformed/oversized metadata. No network or external entity access
    # is needed to interpret this self-contained calibration.
    if len(description) > 2 * 1024 * 1024 or "<!DOCTYPE" in description.upper() or "<!ENTITY" in description.upper():
        return {}
    try:
        root = ET.fromstring(description.strip())
    except (ET.ParseError, ValueError):
        return {}
    if not root.tag.endswith("}OME"):
        return {}
    namespace = root.tag[:-3]
    if not namespace.startswith(("{http://www.openmicroscopy.org/Schemas/OME/", "{https://www.openmicroscopy.org/Schemas/OME/")):
        return {}
    candidates = []
    for pixels in root.findall(f"{namespace}Image/{namespace}Pixels"):
        try:
            if (int(pixels.get("SizeX", "0")), int(pixels.get("SizeY", "0"))) == dimensions:
                candidates.append(pixels)
        except ValueError:
            continue
    # Do not apply a thumbnail's calibration or guess between multiple series.
    if len(candidates) != 1:
        return {}
    pixels = candidates[0]
    properties = {}
    for axis, key in (("X", openslide.PROPERTY_NAME_MPP_X), ("Y", openslide.PROPERTY_NAME_MPP_Y)):
        unit = pixels.get(f"PhysicalSize{axis}Unit", "µm")
        if unit not in MICRONS_PER_UNIT:
            continue
        try:
            value = float(pixels.get(f"PhysicalSize{axis}", "")) * MICRONS_PER_UNIT[unit]
        except ValueError:
            continue
        if math.isfinite(value) and value > 0:
            properties[key] = format(value, ".15g")
    if properties:
        properties["myogentic.calibration-source"] = "OME PhysicalSizeX/PhysicalSizeY"
    return properties

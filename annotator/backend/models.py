import json
from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator

from .config import ROOT

DEFINITION_VERSIONS = {definition["version"]: definition for definition in (
    json.loads(path.read_text()) for path in sorted((ROOT / "schemas").glob("annotations-*.json"))
)}
DEFINITIONS = DEFINITION_VERSIONS["4.3"]
V3_FINDING_TYPES = {f["id"]: {t["id"] for t in f["types"]} for f in DEFINITION_VERSIONS["3.0"]["findings"] if "types" in f}
GRADED_FINDINGS = [item["id"] for finding in DEFINITIONS["findings"] for item in finding.get("types", [finding])]
Presence = Literal["unassessed", "present", "absent", "uncertain", "not_assessable"]
Severity = Literal["unassessed", "mild", "moderate", "marked", "not_applicable"]
Certainty = Literal["unassessed", "low", "moderate", "high"]
Kind = Literal["individual", "adjudicated"]
FindingGrade = Literal["unassessed", "grade_1", "grade_2", "grade_3", "not_applicable"]


class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)


class Pattern(StrictModel):
    presence: Presence = "unassessed"
    severity: Severity = "unassessed"
    certainty: Certainty = "high"


class Evidence(StrictModel):
    id: str = Field(min_length=1, max_length=100)
    label: str = Field(default="", max_length=500)


class Rectangle(StrictModel):
    x: float = Field(ge=0)
    y: float = Field(ge=0)
    width: float = Field(gt=0)
    height: float = Field(gt=0)

    def fits_slide(self, width: int, height: int) -> bool:
        return self.x + self.width <= width + 0.01 and self.y + self.height <= height + 0.01


class Region(Evidence, Rectangle):
    pass


Coordinate = Annotated[float, Field(ge=0)]


class StrokeGeometry(StrictModel):
    diameter: float = Field(gt=0)
    points: list[tuple[Coordinate, Coordinate]] = Field(min_length=1, max_length=8192)

    def fits_slide(self, width: int, height: int) -> bool:
        return self.diameter <= 2 * max(width, height) and all(x <= width and y <= height for x, y in self.points)


class BrushRegion(Evidence, StrokeGeometry):
    shape: Literal["brush"]


class RegionStroke(StrokeGeometry):
    mode: Literal["paint", "erase", "outline", "fill"]

    @model_validator(mode="after")
    def validate_fill(self):
        if self.mode == "fill":
            first = self.points[0]
            second = next((p for p in self.points if p != first), None)
            if second is None or not any(
                (second[0] - first[0]) * (y - first[1]) != (second[1] - first[1]) * (x - first[0])
                for x, y in self.points
            ):
                raise ValueError("A filled outline needs three non-collinear points")
        return self


class CompoundRegion(Evidence):
    shape: Literal["compound"]
    base: Rectangle | None = None
    strokes: list[RegionStroke] = Field(min_length=1, max_length=512)

    @model_validator(mode="after")
    def validate_first_stroke(self):
        if self.base is None and self.strokes[0].mode == "erase":
            raise ValueError("Paint a region before erasing it")
        return self

    def fits_slide(self, width: int, height: int) -> bool:
        return (self.base is None or self.base.fits_slide(width, height)) and all(stroke.fits_slide(width, height) for stroke in self.strokes)


class LegacyAssessment(StrictModel):
    schema_version: Literal["1.0", "1.1"] = "1.1"
    status: Literal["in_progress", "complete"] = "in_progress"
    overall: Literal["unassessed", "no_abnormality_identified", "abnormal", "uncertain", "not_assessable"] = "unassessed"
    extent: Literal["unassessed", "focal", "multifocal", "diffuse", "not_assessable"] = "unassessed"
    certainty: Certainty = "high"
    dominant: Literal["none", "myopathic", "dystrophic", "inflammatory", "neurogenic", "mixed", "uncertain"] = "none"
    patterns: dict[str, Pattern] = Field(default_factory=lambda: {p["id"]: Pattern() for p in DEFINITIONS["patterns"]})
    findings: dict[str, Presence] = Field(default_factory=lambda: {f["id"]: "unassessed" for f in DEFINITION_VERSIONS["1.1"]["findings"]})
    comments: str = Field(default="", max_length=20000)
    regions: list[Region] = Field(default_factory=list, max_length=500)

    @model_validator(mode="after")
    def validate_document(self):
        definitions = DEFINITION_VERSIONS[self.schema_version]
        if self.schema_version != "1.0" and (self.certainty == "unassessed" or any(p.certainty == "unassessed" for p in self.patterns.values())):
            raise ValueError("Confidence must be low, moderate, or high")
        if set(self.patterns) != {p["id"] for p in definitions["patterns"]}:
            raise ValueError("Pattern keys must match the versioned definitions")
        finding_ids = GRADED_FINDINGS if self.schema_version in {"4.0", "4.1", "4.2", "4.3"} else [f["id"] for f in definitions["findings"]]
        if set(self.findings) != set(finding_ids):
            raise ValueError("Finding keys must match the versioned definitions")
        if len({r.id for r in self.regions}) != len(self.regions):
            raise ValueError("Evidence region IDs must be unique")
        if self.status == "complete" and self.overall == "unassessed":
            raise ValueError("Choose an overall annotation before completing this review")
        if self.status == "complete" and self.dominant in {"none", "unassessed"}:
            raise ValueError("Choose a main pattern before completing this review")
        return self


class LegacyFindings(StrictModel):
    schema_version: Literal["1.0", "1.1"]
    findings: dict[str, Presence]

    @model_validator(mode="after")
    def validate_keys(self):
        if set(self.findings) != {f["id"] for f in DEFINITION_VERSIONS[self.schema_version]["findings"]}:
            raise ValueError("Earlier findings must match their original definitions")
        return self


class AssessmentV2(LegacyAssessment):
    schema_version: Literal["2.0"] = "2.0"
    dominant: Literal["unassessed", "myopathic", "dystrophic", "inflammatory", "neurogenic", "mixed", "no_dominant_pattern", "uncertain", "not_assessable"] = "unassessed"
    findings: dict[str, Presence] = Field(default_factory=lambda: {f["id"]: "unassessed" for f in DEFINITION_VERSIONS["2.0"]["findings"]})
    finding_grades: dict[str, FindingGrade] = Field(default_factory=lambda: {f["id"]: "unassessed" for f in DEFINITION_VERSIONS["2.0"]["findings"]})
    legacy_findings: LegacyFindings | None = None

    @model_validator(mode="after")
    def validate_current_document(self):
        if set(self.finding_grades) != set(self.findings):
            raise ValueError("Finding grade keys must match the versioned findings")
        for finding, grade in self.finding_grades.items():
            if grade.startswith("grade_") and self.findings[finding] not in {"present", "uncertain"}:
                raise ValueError("A finding must be present or uncertain before assigning a grade")
        return self


class PreviousFindingsV2(StrictModel):
    schema_version: Literal["2.0"]
    findings: dict[str, Presence]
    finding_grades: dict[str, FindingGrade]
    legacy_findings: LegacyFindings | None = None

    @model_validator(mode="after")
    def validate_snapshot(self):
        expected = {f["id"] for f in DEFINITION_VERSIONS[self.schema_version]["findings"]}
        if set(self.findings) != expected or set(self.finding_grades) != expected:
            raise ValueError("Earlier findings and grades must match their original definitions")
        return self


def validate_v3_types(findings, finding_types):
    if finding_types.keys() != V3_FINDING_TYPES.keys():
        raise ValueError("Type groups must match the versioned findings")
    for finding, selected in finding_types.items():
        if len(set(selected)) != len(selected) or not set(selected) <= V3_FINDING_TYPES[finding]:
            raise ValueError(f"Invalid or repeated type for {finding}")
        if selected and findings[finding] not in {"present", "uncertain"}:
            raise ValueError("A finding must be present or uncertain before assigning a type")


class AssessmentV3(AssessmentV2):
    schema_version: Literal["3.0"] = "3.0"
    findings: dict[str, Presence] = Field(default_factory=lambda: {f["id"]: "unassessed" for f in DEFINITION_VERSIONS["3.0"]["findings"]})
    finding_grades: dict[str, FindingGrade] = Field(default_factory=lambda: {f["id"]: "unassessed" for f in DEFINITION_VERSIONS["3.0"]["findings"]})
    finding_types: dict[str, list[str]] = Field(default_factory=lambda: {key: [] for key in V3_FINDING_TYPES})
    legacy_findings: LegacyFindings | PreviousFindingsV2 | None = None

    @model_validator(mode="after")
    def validate_finding_types(self):
        validate_v3_types(self.findings, self.finding_types)
        return self


class PreviousFindingsV3(PreviousFindingsV2):
    schema_version: Literal["3.0"]
    finding_types: dict[str, list[str]]
    legacy_findings: LegacyFindings | PreviousFindingsV2 | None = None

    @model_validator(mode="after")
    def validate_types(self):
        validate_v3_types(self.findings, self.finding_types)
        return self


class Assessment(AssessmentV2):
    schema_version: Literal["4.0", "4.1", "4.2", "4.3"] = "4.3"
    regions: list[Region | BrushRegion | CompoundRegion] = Field(default_factory=list, max_length=500)
    findings: dict[str, Presence] = Field(default_factory=lambda: dict.fromkeys(GRADED_FINDINGS, "unassessed"))
    finding_grades: dict[str, FindingGrade] = Field(default_factory=lambda: dict.fromkeys(GRADED_FINDINGS, "unassessed"))
    legacy_findings: LegacyFindings | PreviousFindingsV2 | PreviousFindingsV3 | None = None

    @model_validator(mode="after")
    def validate_region_version(self):
        if self.schema_version != "4.3" and any(isinstance(region, CompoundRegion) for region in self.regions):
            raise ValueError("Compound regions require annotation version 4.3")
        if self.schema_version not in {"4.2", "4.3"} and any(isinstance(region, BrushRegion) for region in self.regions):
            raise ValueError("Brush regions require annotation version 4.2")
        return self


class SaveRequest(StrictModel):
    expected_revision: int = Field(ge=0)
    assessment: Annotated[Assessment | AssessmentV3 | AssessmentV2 | LegacyAssessment, Field(discriminator="schema_version")]

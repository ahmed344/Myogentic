import json
from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator

from .config import ROOT

DEFINITION_VERSIONS = {definition["version"]: definition for definition in (
    json.loads(path.read_text()) for path in sorted((ROOT / "schemas").glob("annotations-*.json"))
)}
DEFINITIONS = DEFINITION_VERSIONS["2.0"]
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


class Region(StrictModel):
    id: str = Field(min_length=1, max_length=100)
    label: str = Field(default="", max_length=500)
    x: float = Field(ge=0)
    y: float = Field(ge=0)
    width: float = Field(gt=0)
    height: float = Field(gt=0)


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
        if set(self.findings) != {f["id"] for f in definitions["findings"]}:
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


class Assessment(LegacyAssessment):
    schema_version: Literal["2.0"] = "2.0"
    dominant: Literal["unassessed", "myopathic", "dystrophic", "inflammatory", "neurogenic", "mixed", "no_dominant_pattern", "uncertain", "not_assessable"] = "unassessed"
    findings: dict[str, Presence] = Field(default_factory=lambda: {f["id"]: "unassessed" for f in DEFINITIONS["findings"]})
    finding_grades: dict[str, FindingGrade] = Field(default_factory=lambda: {f["id"]: "unassessed" for f in DEFINITIONS["findings"]})
    legacy_findings: LegacyFindings | None = None

    @model_validator(mode="after")
    def validate_current_document(self):
        if set(self.finding_grades) != set(self.findings):
            raise ValueError("Finding grade keys must match the versioned findings")
        for finding, grade in self.finding_grades.items():
            if grade.startswith("grade_") and self.findings[finding] not in {"present", "uncertain"}:
                raise ValueError("A finding must be present or uncertain before assigning a grade")
        return self


class SaveRequest(StrictModel):
    expected_revision: int = Field(ge=0)
    assessment: Annotated[Assessment | LegacyAssessment, Field(discriminator="schema_version")]

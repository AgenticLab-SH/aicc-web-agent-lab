from pathlib import Path
import sys

from reportlab.lib import colors
from reportlab.lib.enums import TA_LEFT
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.lib.units import mm
from reportlab.platypus import Paragraph, SimpleDocTemplate, Spacer, Table, TableStyle


output = Path(sys.argv[1])
output.parent.mkdir(parents=True, exist_ok=True)

styles = getSampleStyleSheet()
styles.add(ParagraphStyle(
    name="PhaseTitle",
    parent=styles["Title"],
    fontName="Helvetica-Bold",
    fontSize=22,
    leading=27,
    textColor=colors.HexColor("#17233C"),
    alignment=TA_LEFT,
    spaceAfter=8 * mm,
))
styles.add(ParagraphStyle(
    name="PhaseBody",
    parent=styles["BodyText"],
    fontName="Helvetica",
    fontSize=10.5,
    leading=15,
    textColor=colors.HexColor("#26344D"),
))

document = SimpleDocTemplate(
    str(output),
    pagesize=A4,
    leftMargin=20 * mm,
    rightMargin=20 * mm,
    topMargin=18 * mm,
    bottomMargin=18 * mm,
    title="AICC Phase 07 Durable Artifact Proof",
    author="AICC Phase 07 fixture",
)

story = [
    Paragraph("AICC Phase 07", styles["PhaseTitle"]),
    Paragraph("Durable Job and Artifact Verification", styles["Heading2"]),
    Spacer(1, 4 * mm),
    Paragraph(
        "This task-owned document proves that a PDF output is generated, rendered, hashed, "
        "and linked to a durable job before the job is marked complete.",
        styles["PhaseBody"],
    ),
    Spacer(1, 7 * mm),
]

data = [
    ["Invariant", "Observed rule"],
    ["Single writer", "One write lease per workspace"],
    ["Recovery", "Expired attempts pause before resume"],
    ["Idempotency", "Duplicate submit and effect are suppressed"],
    ["Artifact", "Current SHA-256 plus rendered evidence required"],
]
table = Table(data, colWidths=[48 * mm, 112 * mm], repeatRows=1)
table.setStyle(TableStyle([
    ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#244B7A")),
    ("TEXTCOLOR", (0, 0), (-1, 0), colors.white),
    ("FONTNAME", (0, 0), (-1, 0), "Helvetica-Bold"),
    ("FONTNAME", (0, 1), (-1, -1), "Helvetica"),
    ("FONTSIZE", (0, 0), (-1, -1), 9.5),
    ("LEADING", (0, 0), (-1, -1), 13),
    ("BACKGROUND", (0, 1), (-1, -1), colors.HexColor("#F3F6FA")),
    ("GRID", (0, 0), (-1, -1), 0.5, colors.HexColor("#AAB5C5")),
    ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
    ("LEFTPADDING", (0, 0), (-1, -1), 8),
    ("RIGHTPADDING", (0, 0), (-1, -1), 8),
    ("TOPPADDING", (0, 0), (-1, -1), 7),
    ("BOTTOMPADDING", (0, 0), (-1, -1), 7),
]))
story.extend([
    table,
    Spacer(1, 8 * mm),
    Paragraph(
        "Verification domains stay separate: source, test runtime, rendered output, and "
        "user-visible workflow do not substitute for each other.",
        styles["PhaseBody"],
    ),
])

document.build(story)

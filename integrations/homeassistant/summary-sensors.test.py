"""Validate YAML and table extraction with Home Assistant template globals stubbed."""
from pathlib import Path
from datetime import datetime
import unittest
import yaml
from jinja2.sandbox import SandboxedEnvironment

ROOT = Path(__file__).parent
SENSORS = yaml.safe_load((ROOT / "summary-sensors.yaml").read_text(encoding="utf-8"))[0]["sensor"]
PROXMOX = "| Nodo | CPU (%) | RAM (%) | VM running |\n|---|---|---|---|\n| pve | 12.34 | 56.78 | 3 |"
HA = "| Errores | Integración / mensaje | Apariciones |\n|---|---|---|\n| Total | muestra system | 9 |\n| Top 1 | ejemplo | 5 |\n\n| Warnings | Integración / mensaje | Apariciones |\n|---|---|---|\n| Total | muestra system | 0 |"
REPORT = "## Proxmox\n### Tabla de nodos\n" + PROXMOX + "\n### Estado general\nDetalle Proxmox\n## Home Assistant\n### Tablas de logs\n" + HA + "\n### Cobertura del análisis\nDetalle HA"

def render(sensor, field, report, available=True):
    attrs = {"report": report, "generated_at": "2026-09-16T08:00:00+00:00"}
    env = SandboxedEnvironment()
    def timestamp(raw, default=None):
        try:
            return datetime.fromisoformat(raw).timestamp()
        except (ValueError, TypeError):
            return default
    env.globals.update(
        state_attr=lambda entity, key: attrs.get(key),
        states=lambda entity: attrs["generated_at"] if available else "unavailable",
        as_timestamp=timestamp,
    )
    template = sensor["attributes"]["report"] if field == "report" else sensor[field]
    return env.from_string(template).render().strip()

class SummaryTests(unittest.TestCase):
    def test_entity_names_and_cards(self):
        self.assertEqual([s["name"] for s in SENSORS], ["proxmox_summary", "homeassistant_summary"])
        cards = yaml.safe_load((ROOT / "summary-cards.yaml").read_text(encoding="utf-8"))
        self.assertEqual(len(cards["cards"]), 2)

    def test_sections_are_isolated_and_digits_preserved(self):
        for report in [REPORT, REPORT.replace("\n", "\r\n")]:
            for sensor, expected in zip(SENSORS, [PROXMOX, HA]):
                self.assertEqual(render(sensor, "availability", report), "True")
                self.assertEqual(render(sensor, "report", report), expected)

    def test_old_missing_and_unavailable_reports(self):
        for sensor in SENSORS:
            for report in [None, "", "Old narrative summary"]:
                self.assertEqual(render(sensor, "availability", report), "False")
                self.assertIn("Esperando", render(sensor, "report", report))
            self.assertEqual(render(sensor, "availability", REPORT, False), "False")

    def test_missing_end_marker_does_not_leak_other_sections(self):
        for sensor, marker in zip(SENSORS, ["### Estado general", "### Cobertura del análisis"]):
            report = REPORT.replace(marker, "Unknown heading")
            self.assertEqual(render(sensor, "availability", report), "False")
            self.assertIn("Esperando", render(sensor, "report", report))

if __name__ == "__main__":
    unittest.main()

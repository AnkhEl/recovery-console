"""Freeze closed OSM building ways from a small, manually downloaded XML extract.

Usage: python3 scripts/extract-sight-line-footprints.py map.osm
The input is a one-time OSM XML map extract. Runtime never contacts OSM.
"""

import json
import sys
import xml.etree.ElementTree as ET
from pathlib import Path


def crosses(a, b, c, d):
    def turn(p, q, r):
        return (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0])

    return turn(a, b, c) * turn(a, b, d) < 0 and turn(c, d, a) * turn(c, d, b) < 0


def questionable_ring(points):
    edges = len(points) - 1
    area = sum(
        points[i][0] * points[i + 1][1] - points[i + 1][0] * points[i][1]
        for i in range(edges)
    )
    if abs(area) < 1e-13:
        return True
    return any(
        crosses(points[i], points[i + 1], points[j], points[j + 1])
        for i in range(edges)
        for j in range(i + 2, edges)
        if not (i == 0 and j == edges - 1)
    )


def main():
    root = ET.parse(sys.argv[1]).getroot()
    nodes = {
        node.attrib["id"]: [float(node.attrib["lon"]), float(node.attrib["lat"])]
        for node in root.findall("node")
    }
    footprints = []
    rejected = []
    for way in root.findall("way"):
        tags = {tag.attrib["k"]: tag.attrib["v"] for tag in way.findall("tag")}
        if "building" not in tags:
            continue
        refs = [nd.attrib["ref"] for nd in way.findall("nd")]
        reason = None
        if len(refs) < 4 or refs[0] != refs[-1]:
            reason = "open_or_too_short"
        elif any(ref not in nodes for ref in refs):
            reason = "missing_node"
        elif tags["building"] in {"roof", "bridge"}:
            reason = "not_ground_level"
        elif "min_height" in tags:
            try:
                if float(tags["min_height"].removesuffix(" m")) > 2:
                    reason = "not_ground_level"
            except ValueError:
                reason = "uncertain_height"
        if not reason and questionable_ring([nodes[ref] for ref in refs]):
            reason = "questionable_geometry"
        if reason:
            rejected.append({"osmWayId": way.attrib["id"], "reason": reason})
            continue
        footprints.append(
            {
                "id": f"osm-way-{way.attrib['id']}",
                "coordinates": [nodes[ref] for ref in refs],
                "buildingTag": tags["building"],
            }
        )
    output = {
        "version": "mapped-footprints-v1",
        "source": "OpenStreetMap contributors; frozen OSM API map extract",
        "attribution": "© OpenStreetMap contributors (ODbL)",
        "extractedUtc": "2026-09-28T06:17:43Z",
        "bounds": [28.045, -26.107, 28.052, -26.1025],
        "coverage": "Incomplete and unverified; a clear mapped line is uncertain visibility",
        "rejected": rejected,
        "footprints": footprints,
    }
    path = Path("src/data/sight-line-footprints.v1.json")
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(output, indent=2) + "\n")
    print(f"Wrote {len(footprints)} footprints; rejected {len(rejected)} ways")


if __name__ == "__main__":
    main()

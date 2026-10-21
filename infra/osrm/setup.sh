#!/usr/bin/env bash
# Prepare OSRM data (spec §11). Downloads the Tanzania extract, crops it to the
# Rukwa region bounding box (keeps processing light — peak RAM ~350 MB, fits a
# small VPS), then runs the OSRM MLD pipeline. Re-run monthly to refresh
# (see docs/RUNBOOK.md#refresh-osrm-data). Requires docker + ~2 GB free disk.
set -euo pipefail
cd "$(dirname "$0")"
mkdir -p data
cd data

IMG=ghcr.io/project-osrm/osrm-backend:latest
# Rukwa region bounding box: minlon,minlat,maxlon,maxlat (covers Sumbawanga +
# the whole region). Widen if you launch a second city outside this box.
BBOX="29.8,-9.2,32.8,-6.5"

echo "Downloading Tanzania extract from Geofabrik…"
curl -fLO https://download.geofabrik.de/africa/tanzania-latest.osm.pbf

echo "Cropping to the Rukwa region ($BBOX)…"
docker run --rm -v "$PWD:/data" stefda/osmium-tool \
  osmium extract --bbox="$BBOX" --strategy=complete_ways --overwrite \
  -o /data/rukwa.osm.pbf /data/tanzania-latest.osm.pbf

echo "Extracting (car profile — acceptable for all classes at MVP, spec §11)…"
docker run --rm -v "$PWD:/data" "$IMG" osrm-extract -p /opt/car.lua /data/rukwa.osm.pbf

echo "Partitioning + customizing (MLD)…"
docker run --rm -v "$PWD:/data" "$IMG" osrm-partition /data/rukwa.osrm
docker run --rm -v "$PWD:/data" "$IMG" osrm-customize /data/rukwa.osrm

echo "Done. Data at infra/osrm/data/rukwa.osrm*"
echo "Dev:  docker run -d --name rukwaride-osrm -p 5000:5000 -v \"\$PWD:/data\" $IMG osrm-routed --algorithm mld /data/rukwa.osrm"
echo "Prod: docker compose -f ../docker-compose.prod.yml --profile routing up -d osrm"

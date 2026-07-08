"""Local web server for the interactive Iron Age network GUI."""

from __future__ import annotations

import argparse
import json
import mimetypes
import threading
import webbrowser
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

import model


ROOT = Path(__file__).resolve().parent
APP_DIR = ROOT / "app"
LEAFLET_DIR = ROOT / "node_modules" / "leaflet" / "dist"
SAVED_SCENARIO = ROOT / "data" / "saved_scenario.json"
MAX_POST_BYTES = 25 * 1024 * 1024


class Application:
    def __init__(self) -> None:
        self.lock = threading.Lock()
        self.bootstrap_data = model.bootstrap()
        self.itinere = model.load_itinere()

    def regenerate_edges(self, k_neighbors: int, max_distance_km: float) -> list[dict]:
        with self.lock:
            return model.build_edges(
                self.bootstrap_data["nodes"],
                k_neighbors=k_neighbors,
                max_distance_km=max_distance_km,
                itinere=self.itinere,
            )


APP = Application()


class Handler(BaseHTTPRequestHandler):
    server_version = "IronAgeNetwork/0.1"

    def log_message(self, format_string: str, *args) -> None:
        print(f"[{self.log_date_time_string()}] {format_string % args}")

    def json_response(self, payload, status: HTTPStatus = HTTPStatus.OK) -> None:
        encoded = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(encoded)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.end_headers()
        self.wfile.write(encoded)

    def file_response(self, path: Path) -> None:
        if not path.exists() or not path.is_file():
            self.send_error(HTTPStatus.NOT_FOUND)
            return
        content = path.read_bytes()
        mime_type, _ = mimetypes.guess_type(str(path))
        self.send_response(HTTPStatus.OK)
        self.send_header(
            "Content-Type",
            f"{mime_type or 'application/octet-stream'}"
            + ("; charset=utf-8" if path.suffix in {".html", ".css", ".js"} else ""),
        )
        self.send_header("Content-Length", str(len(content)))
        self.send_header("Cache-Control", "no-cache")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.end_headers()
        self.wfile.write(content)

    def do_GET(self) -> None:
        parsed = urlparse(self.path)
        path = parsed.path
        if path == "/api/health":
            self.json_response(
                {
                    "status": "ok",
                    "nodes": len(APP.bootstrap_data["nodes"]),
                    "edges": len(APP.bootstrap_data["edges"]),
                }
            )
            return
        if path == "/api/bootstrap":
            self.json_response(APP.bootstrap_data)
            return
        if path == "/api/itinere":
            self.json_response(APP.itinere)
            return
        if path == "/api/saved":
            if not SAVED_SCENARIO.exists():
                self.json_response({"saved": False, "scenario": None})
                return
            self.json_response(
                {
                    "saved": True,
                    "scenario": json.loads(SAVED_SCENARIO.read_text(encoding="utf-8")),
                }
            )
            return
        if path == "/api/edges":
            query = parse_qs(parsed.query)
            try:
                k_neighbors = max(1, min(8, int(query.get("k", ["3"])[0])))
                max_distance = max(
                    20.0,
                    min(500.0, float(query.get("maxDistanceKm", ["180"])[0])),
                )
            except ValueError:
                self.json_response(
                    {"error": "Ungültige Parameter für die Kantengenerierung."},
                    HTTPStatus.BAD_REQUEST,
                )
                return
            self.json_response(
                {
                    "edges": APP.regenerate_edges(k_neighbors, max_distance),
                    "kNeighbors": k_neighbors,
                    "maxDistanceKm": max_distance,
                }
            )
            return

        if path in {"/", "/index.html"}:
            self.file_response(APP_DIR / "index.html")
            return
        if path == "/vendor/leaflet.css":
            self.file_response(LEAFLET_DIR / "leaflet.css")
            return
        if path == "/vendor/leaflet.js":
            self.file_response(LEAFLET_DIR / "leaflet.js")
            return
        if path.startswith("/vendor/images/"):
            self.file_response(LEAFLET_DIR / "images" / Path(path).name)
            return
        relative = path.lstrip("/")
        candidate = (APP_DIR / relative).resolve()
        if APP_DIR.resolve() not in candidate.parents:
            self.send_error(HTTPStatus.FORBIDDEN)
            return
        self.file_response(candidate)

    def do_POST(self) -> None:
        parsed = urlparse(self.path)
        if parsed.path != "/api/save":
            self.send_error(HTTPStatus.NOT_FOUND)
            return
        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            length = 0
        if length <= 0 or length > MAX_POST_BYTES:
            self.json_response(
                {"error": "Leerer oder zu großer Szenariodatensatz."},
                HTTPStatus.REQUEST_ENTITY_TOO_LARGE,
            )
            return
        try:
            scenario = json.loads(self.rfile.read(length))
        except (json.JSONDecodeError, UnicodeDecodeError):
            self.json_response(
                {"error": "Szenario ist kein gültiges JSON."},
                HTTPStatus.BAD_REQUEST,
            )
            return
        if not isinstance(scenario, dict) or not isinstance(
            scenario.get("nodes"), list
        ):
            self.json_response(
                {"error": "Szenarioformat unvollständig."},
                HTTPStatus.BAD_REQUEST,
            )
            return
        temporary = SAVED_SCENARIO.with_suffix(".tmp")
        temporary.write_text(
            json.dumps(scenario, ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
        )
        temporary.replace(SAVED_SCENARIO)
        self.json_response({"saved": True, "path": str(SAVED_SCENARIO)})


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--open", action="store_true", help="Open the browser")
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    server = ThreadingHTTPServer((args.host, args.port), Handler)
    url = f"http://{args.host}:{args.port}/"
    print(f"Eisenzeit-Netzwerk läuft unter {url}")
    print("Beenden mit Strg+C.")
    if args.open:
        threading.Timer(0.5, lambda: webbrowser.open(url)).start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nServer beendet.")
    finally:
        server.server_close()


if __name__ == "__main__":
    main()

# Eisenzeit-Netzwerk-Labor

Lokale Webanwendung zur explorativen Modellierung von Fundorten, Verbindungshypothesen, Transportwegen und typgetrennter Münzzirkulation in einem editierbaren Graphen.

Das Projekt versteht sich als Forschungs- und Lehrprototyp. Es erzeugt keine endgültige historische Rekonstruktion, sondern macht Modellannahmen sichtbar, veränderbar und vergleichbar.

## Überblick

Das Eisenzeit-Netzwerk-Labor verbindet:

- Fundorte als Knoten eines Graphen
- Verkehrs- und Verbindungshypothesen als gewichtete Kanten
- editierbare Transportmodi wie Fußweg, Packtier, Wagen, Flussboot oder Küstenroute
- typgetrennte Münzmengen aus numismatischen CSV-Daten
- zeitliche Simulation in 25-Jahres-Schritten
- optionale Datierungsintervalle pro Münztyp
- interaktive Bearbeitung von Knoten, Kanten, Gewichten und Startverteilungen

Die Anwendung läuft vollständig lokal im Browser. Der Python-Server stellt nur Daten und statische Dateien bereit.

## Funktionsumfang

### Interaktiver Graph

- Fundorte werden als Knoten auf einer Leaflet-Karte angezeigt.
- Kanten bilden prüfbare Verbindungshypothesen.
- Kanten können aktiviert, deaktiviert, manuell ergänzt oder gelöscht werden.
- Transportmodus und Handelsstärke sind pro Kante editierbar.

### Verkehrsmodell

Die Kantenleitfähigkeit kombiniert:

- Distanz
- Reisezeit
- Verkehrsmodus
- Kosten und Kapazität
- Terrain-Proxy
- Kontaktreichweite
- größenkorrigierte Handelsstärke
- numismatischen Münz-Proxy

Wasserwege und Itiner-e-Daten dienen als Vergleichs- und Modellgrundlage, nicht als automatischer Nachweis eisenzeitlicher Wege.

### Typgetrennte Münzsimulation

Münzen werden nicht als eine einzige Gesamtmenge simuliert, sondern pro Typcode getrennt geführt:

```text
x_i,m(t) = Münzmenge von Typ m an Knoten i zur Zeit t
```

Dadurch lassen sich einzelne Münztypen filtern, verteilen und über die Zeit verfolgen.

### Typfilter und Datierungen

Der Typfilter beschränkt:

- Simulation
- Karte
- Knotenwerte
- Zusammenfassungen
- Münz-Proxy
- gefilterte Startverteilungen

Datierungsintervalle pro Münztyp legen fest, in welchen Jahren ein Typ wandern darf. Außerhalb des Intervalls bleibt die vorhandene Menge am aktuellen Knoten erhalten.

### Szenarien

Szenarien können als JSON exportiert und später wieder importiert werden. Gespeichert werden unter anderem:

- Einstellungen
- Transportmodi
- Typfilter
- Typdatierungen
- Knoten-Startmengen
- typgetrennte Startmengen
- Kanten und Kantenparameter

## Datenbasis

Das Projekt verwendet lokale CSV- und GeoJSON-Dateien:

- Fundort-CSV mit Fundorten und GeoNames-Verweisen
- Münz-CSV mit Fundort-, Kontext- und Typcode-Daten
- GeoNames-Cache für Koordinaten
- Itiner-e-Ausschnitt für Flüsse, Straßen und Seerouten

Kontrollwerte des derzeitigen Datensatzes:

- 182 Fundorte
- 375 initiale Kanten
- 7.035 Münzdatensätze
- 148 nichtleere Typcodes aus `Type | Code`

## Repository-Struktur

```text
.
├── app/
│   ├── index.html
│   ├── app.js
│   └── styles.css
├── data/
│   ├── geonames_cache.json
│   └── itinere_central_europe.geojson
├── scripts/
│   ├── build_geocache.py
│   └── fetch_itinere.py
├── tests/
│   └── test_model.py
├── model.py
├── server.py
├── start.cmd
├── start.ps1
├── package.json
├── pnpm-lock.yaml
├── export_Immovables_15.4.2026-tchi1_Fundorte_Geonames_Link.csv
└── export_Numismatic object_14.4.2026-numisdata4_Muenzen_Fundort_Kontext.csv
```

## Installation

### Voraussetzungen

- Python 3.10 oder neuer
- moderner Browser
- Node.js oder pnpm, falls die lokalen Browser-Abhängigkeiten neu installiert werden sollen

Für den Python-Server werden keine externen Python-Pakete benötigt.

### Abhängigkeiten installieren

Die Browser-Bibliothek Leaflet wird über `package.json` verwaltet.

Mit npm:

```powershell
npm install
```

Mit pnpm:

```powershell
pnpm install
```

Wenn `node_modules/leaflet` bereits vorhanden ist, ist keine erneute Installation erforderlich.

## Start

### Windows

```powershell
.\start.ps1
```

oder:

```text
start.cmd
```

Die Anwendung öffnet standardmäßig:

```text
http://127.0.0.1:8765/
```

### Manuell

```powershell
python server.py --open
```

Ohne automatisches Browserfenster:

```powershell
python server.py
```

Danach im Browser öffnen:

```text
http://127.0.0.1:8765/
```

### Anderer Port

Falls Port `8765` bereits belegt ist:

```powershell
python server.py --port 8766 --open
```

## Nutzung

Typischer Arbeitsablauf:

1. Anwendung starten.
2. Fundmengen aus CSV übernehmen oder eigene Startmengen setzen.
3. Optional Münztypen im Typfilter auswählen.
4. Optional Datierungsintervalle im Dialog `Münzdatierung` ergänzen.
5. Kanten, Transportmodi und Gewichte prüfen oder bearbeiten.
6. Simulation über den Zeitregler oder den Play-Button betrachten.
7. Knoteninspektor für aktuelle Münzmengen und Typverteilungen nutzen.
8. Szenario als JSON exportieren.

## Mathematische Modellbestandteile

### Größenkorrigierte Handelsstärke

```text
H_ij = s_ij / sqrt(size_i * size_j)
```

Damit wird dieselbe absolute Kantenstärke zwischen kleineren Siedlungen relativ stärker gewichtet als zwischen größeren Zentren.

### Reisezeit

```text
travel_time_ij = distance_ij * terrain_factor_ij / speed_mode
```

Die Reisezeit wird in eine gesättigte Reisechance überführt:

```text
A_ij = trips_per_year / (trips_per_year + 1)
```

### Kantenleitfähigkeit

```text
K_ij =
  H_ij
* distance_scale / (distance_scale + distance_ij)
* mode_capacity / (mode_cost * terrain_penalty)
* A_ij
* (1 + coin_weight * P_ij)
```

### Münz-Proxy

Der Münz-Proxy nutzt exakt gemeinsame Typcodes:

```text
P_ij = sum(min(c_i,m, c_j,m)) / sqrt(C_i * C_j)
```

Nur ausgewählte und zeitlich aktive Typen zählen in diesen Proxy.

### Zeitsimulation

Die Oberfläche zeigt 25-Jahres-Schritte. Intern wird quartalsweise gerechnet:

```text
25 Jahre * 4 Teilsteps pro Jahr = 100 interne Teilsteps
```

Für jeden Münztyp wird separat berechnet, ob er im jeweiligen Jahr beweglich ist. Die Menge eines Typs bleibt insgesamt erhalten.

## Tests

Die vorhandenen Daten- und Graphprüfungen werden mit `unittest` ausgeführt:

```powershell
python -m unittest discover -s tests -v
```

Die Tests prüfen unter anderem:

- Quellzählungen
- Geocoding und eindeutige Knoten
- Graph-Zusammenhang
- Flusskanten und Evidenzgeometrien
- Begrenzung des Münz-Proxys

## Reproduzierbarkeit

Hilfsskripte:

```text
scripts/build_geocache.py
scripts/fetch_itinere.py
```

Diese Skripte dienen zur Aktualisierung externer Hilfsdaten. Die mitgelieferten CSV-Ausgangsdaten werden dabei nicht verändert.

## Modellgrenzen

- Fundmengen sind archäologische Beobachtungen, keine direkten historischen Umlaufmengen.
- Siedlungsgrößen sind heuristische Startwerte.
- Kanten sind Verbindungshypothesen, keine automatisch belegten historischen Straßen.
- Itiner-e-Straßen sind römische Vergleichsdaten.
- Wasserwege berücksichtigen derzeit keine Fließrichtung, Pegelstände, Stromschnellen oder saisonale Sperren.
- Der Terrainfaktor ist kein vollständiger Least-Cost-Path.
- Münzdatierungen müssen ergänzt werden, wenn Bewegung und Proxy zeitlich streng modelliert werden sollen.

## Datenprovenienz

- GeoNames-Koordinaten: aus den in der Fundort-CSV verknüpften GeoNames-IDs.
- Itiner-e: vereinfachter Projektausschnitt aus dem offenen Itiner-e-Datenbestand.
- SRTM/Least-Cost-Path: methodische Grundlage für mögliche zukünftige Erweiterungen.
- Verkehrsparameter: editierbare Modellannahmen, orientiert an historischen Transportmodi.

## Veröffentlichungshinweise

Vor einer öffentlichen Git-Veröffentlichung sollten folgende Punkte geprüft werden:

- Lizenz der eigenen Projektdateien festlegen.
- Nutzungs- und Weitergaberechte der CSV-Daten prüfen.
- Nutzungsbedingungen externer Datenquellen dokumentieren.
- Große generierte Dateien gegebenenfalls aus dem Repository entfernen oder als Release-Artefakte bereitstellen.
- Falls Datensätze nicht öffentlich geteilt werden dürfen, nur Beispieldaten veröffentlichen und die Datenpfade dokumentieren.

## Lizenz

Für dieses Repository ist noch keine Lizenzdatei hinterlegt. Vor einer Veröffentlichung sollte eine passende Lizenz ergänzt werden.

## Quellen

- [Itiner-e](https://itiner-e.org/)
- [GeoNames](https://www.geonames.org/)
- [USGS SRTM](https://www.usgs.gov/centers/eros/science/usgs-eros-archive-digital-elevation-shuttle-radar-topography-mission-srtm)
- Tang & Dou 2023: *An Effective Method for Computing the Least-Cost Path Using a Multi-Resolution Raster Cost Surface Model*

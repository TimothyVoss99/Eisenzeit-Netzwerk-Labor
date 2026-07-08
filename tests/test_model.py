from __future__ import annotations

import sys
import unittest
from collections import deque
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

import model  # noqa: E402


class ModelTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.payload = model.bootstrap()

    def test_source_counts(self):
        self.assertEqual(len(self.payload["nodes"]), 182)
        self.assertEqual(self.payload["metadata"]["coinRowCount"], 7035)
        self.assertEqual(len(self.payload["coinTypes"]), 148)

    def test_nodes_are_unique_and_geocoded(self):
        node_ids = [node["id"] for node in self.payload["nodes"]]
        self.assertEqual(len(node_ids), len(set(node_ids)))
        for node in self.payload["nodes"]:
            self.assertGreaterEqual(node["lat"], 43)
            self.assertLessEqual(node["lat"], 53)
            self.assertGreaterEqual(node["lon"], 2)
            self.assertLessEqual(node["lon"], 19)

    def test_generated_graph_is_connected(self):
        adjacency = {node["id"]: [] for node in self.payload["nodes"]}
        for edge in self.payload["edges"]:
            adjacency[edge["source"]].append(edge["target"])
            adjacency[edge["target"]].append(edge["source"])
        start = next(iter(adjacency))
        seen = {start}
        queue = deque([start])
        while queue:
            current = queue.popleft()
            for neighbor in adjacency[current]:
                if neighbor not in seen:
                    seen.add(neighbor)
                    queue.append(neighbor)
        self.assertEqual(set(adjacency), seen)

    def test_river_edges_have_geometry_and_evidence(self):
        river_edges = [
            edge for edge in self.payload["edges"] if edge["mode"] == "river_boat"
        ]
        self.assertGreater(len(river_edges), 20)
        for edge in river_edges:
            self.assertGreaterEqual(len(edge["route"]), 2)
            self.assertTrue(edge["waterway"])
            self.assertTrue(edge["evidenceUri"])

    def test_coin_proxy_is_bounded(self):
        for edge in self.payload["edges"]:
            self.assertGreaterEqual(edge["coinProxy"], 0)
            self.assertLessEqual(edge["coinProxy"], 1)


if __name__ == "__main__":
    unittest.main()

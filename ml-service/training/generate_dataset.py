#!/usr/bin/env python3
"""
Generate training dataset using a Python-native executor that mirrors the Node.js backend.
Logs features + actual measured cost for supervised learning.
"""

import argparse
import csv
import hashlib
import random
import sys
import time
from datetime import datetime
from pathlib import Path

# Request types with cost parameters (matching backend/src/config.js)
REQUEST_TYPES = {
    "image_resize":    {"cpuUnits": 12, "ioMs": 8,  "payloadCpuFactor": 0.5, "label": "Image resize"},
    "hash_compute":    {"cpuUnits": 16, "ioMs": 4,  "payloadCpuFactor": 0.3, "label": "Hash compute"},
    "db_query":        {"cpuUnits": 3,  "ioMs": 30, "payloadCpuFactor": 0.0, "label": "Database query"},
    "report_generate": {"cpuUnits": 28, "ioMs": 20, "payloadCpuFactor": 0.8, "label": "Report generation"},
    "ml_inference":    {"cpuUnits": 12, "ioMs": 12, "payloadCpuFactor": 0.4, "label": "ML inference"},
}

PRIORITIES = ["low", "normal", "high"]
PRECISIONS = ["full", "reduced"]

HASH_ITERATIONS_PER_UNIT = 400
MIN_HASH_ITERATIONS = 500


def iterations_for(req_type: str, payload_size: int) -> int:
    """Compute hash iterations for a request (matches backend)."""
    rt = REQUEST_TYPES[req_type]
    payload_cpu = (payload_size / 1000) * rt["payloadCpuFactor"]
    units = rt["cpuUnits"] + payload_cpu
    iterations = int(round(units * HASH_ITERATIONS_PER_UNIT))
    return max(MIN_HASH_ITERATIONS, iterations)


def io_ms_for(req_type: str) -> int:
    """Get I/O wait time for a request type."""
    return REQUEST_TYPES[req_type]["ioMs"]


def hash_rounds(iterations: int, seed: str) -> str:
    """Synchronous CPU work: SHA-256 rounds."""
    acc = seed
    for i in range(iterations):
        h = hashlib.sha256()
        h.update(acc.encode())
        h.update(str(i).encode())
        acc = h.hexdigest()
    return acc


def execute_request(req: dict) -> dict:
    """
    Execute a request and measure actual cost.
    Mirrors backend/src/workload/executor.js
    """
    req_type = req["type"]
    precision = req.get("precision", "full")

    iterations = iterations_for(req_type, req.get("payloadSize", 0))
    io_ms = io_ms_for(req_type)

    # Precision scaling
    if precision == "reduced":
        iterations = int(iterations * 0.25)
        io_ms = int(io_ms * 0.5)

    seed = f"item:{req.get('parameters', {}).get('itemId', req.get('requestId', 'unknown'))}"

    # Measure
    wall_start = time.perf_counter()
    cpu_start = time.process_time()

    hash_rounds(iterations, seed)
    time.sleep(io_ms / 1000.0)

    cpu_ms = (time.process_time() - cpu_start) * 1000
    wall_ms = (time.perf_counter() - wall_start) * 1000

    # Cloud cost estimation (matches backend cost model)
    billed_ms = max(1.0, wall_ms)
    sec = billed_ms / 1000.0
    vcpu = 1
    mem_mb = 512
    price_vcpu_sec = 0.0000166667
    price_gb_sec = 0.0000166667
    price_inv = 0.0000002
    price_gb_egress = 0.09

    compute = sec * vcpu * price_vcpu_sec
    memory = sec * (mem_mb / 1024) * price_gb_sec
    invocation = price_inv
    egress = (req.get("payloadSize", 0) / 1e9) * price_gb_egress
    cloud_cost = round(compute + memory + invocation + egress, 9)

    return {
        "ok": True,
        "precision": precision,
        "iterations": iterations,
        "ioMs": io_ms,
        "cpuMs": round(cpu_ms, 3),
        "wallMs": round(wall_ms, 3),
        "actualCloudCostUsd": cloud_cost,
        "output": {"itemId": req.get("parameters", {}).get("itemId")},
    }


def synthesize_request(req_id: int, rng: random.Random) -> dict:
    """Generate a synthetic request with random parameters."""
    req_type = rng.choice(list(REQUEST_TYPES.keys()))
    priority = rng.choices(PRIORITIES, weights=[0.2, 0.6, 0.2])[0]
    precision = "full"  # Training data is always full precision

    # Payload size varies by type
    if req_type == "db_query":
        payload = rng.randint(256, 2048)
    elif req_type == "image_resize":
        payload = rng.randint(4096, 16384)
    elif req_type == "report_generate":
        payload = rng.randint(8192, 32768)
    else:
        payload = rng.randint(1024, 8192)

    item_id = rng.randint(0, 99)

    return {
        "requestId": f"syn-{req_id:06d}",
        "type": req_type,
        "payloadSize": payload,
        "priority": priority,
        "precision": precision,
        "parameters": {
            "itemId": item_id,
            "iterations": 0,  # Will be computed
        },
        "clientId": f"gen-client-{rng.randint(1, 10)}",
        "arrivalTs": datetime.now().isoformat(),
    }


def enrich_request(req: dict) -> dict:
    """Add computed fields (iterations)."""
    req["parameters"]["iterations"] = iterations_for(req["type"], req.get("payloadSize", 0))
    return req


def flatten_for_csv(req: dict, result: dict, system_state: dict) -> dict:
    """Flatten request + result + system state into a CSV row."""
    return {
        "requestId": req["requestId"],
        "type": req["type"],
        "payloadSize": req["payloadSize"],
        "iterations": req["parameters"]["iterations"],
        "priority": req["priority"],
        "precision": req["precision"],
        "itemId": req["parameters"].get("itemId", -1),
        "ioMs": result["ioMs"],
        "cpuPct": system_state.get("cpuPct", 0),
        "queueDepth": system_state.get("queueDepth", 0),
        "concurrent": system_state.get("concurrent", 0),
        "actualWallMs": round(result["wallMs"], 3),
        "actualCpuMs": round(result["cpuMs"], 3),
        "actualIoMs": round(result["ioMs"], 3),
        "actualCloudCostUsd": result["actualCloudCostUsd"],
        "timestamp": datetime.now().isoformat(),
    }


def main():
    parser = argparse.ArgumentParser(description="Generate ML training dataset")
    parser.add_argument("--samples", type=int, default=2000, help="Number of requests to generate")
    parser.add_argument("--output", type=str, default="data/requests.csv", help="Output CSV path")
    parser.add_argument("--seed", type=int, default=42, help="Random seed")
    args = parser.parse_args()

    rng = random.Random(args.seed)
    output_path = Path(args.output)
    output_path.parent.mkdir(parents=True, exist_ok=True)

    fieldnames = [
        "requestId", "type", "payloadSize", "iterations", "priority", "precision", "itemId",
        "ioMs", "cpuPct", "queueDepth", "concurrent",
        "actualWallMs", "actualCpuMs", "actualIoMs", "actualCloudCostUsd",
        "timestamp",
    ]

    print(f"[generate_dataset] Generating {args.samples} samples -> {output_path}")

    with open(output_path, "w", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=fieldnames)
        writer.writeheader()

        for i in range(args.samples):
            if i > 0 and i % 200 == 0:
                print(f"[generate_dataset] Progress: {i}/{args.samples}")

            req = synthesize_request(i, rng)
            req = enrich_request(req)

            # Simulate system state (varies during generation)
            system_state = {
                "cpuPct": rng.uniform(10, 80),
                "queueDepth": rng.randint(0, 10),
                "concurrent": rng.randint(0, 8),
            }

            result = execute_request(req)

            row = flatten_for_csv(req, result, system_state)
            writer.writerow(row)

    print(f"[generate_dataset] Done. Wrote {args.samples} rows to {output_path}")


if __name__ == "__main__":
    main()
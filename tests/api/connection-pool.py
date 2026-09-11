"""Verify idle HTTP clients cannot occupy all workers (run against localhost)."""
import http.client
import json
import sys
import time
from urllib.parse import urlparse

url = urlparse(sys.argv[1] if len(sys.argv) > 1 else "http://localhost:3000")
connection = http.client.HTTPSConnection if url.scheme == "https" else http.client.HTTPConnection
clients = []
try:
    for _ in range(3):
        client = connection(url.hostname, url.port, timeout=3)
        clients.append(client)
        client.request("GET", "/health", headers={"Connection": "keep-alive"})
        response = client.getresponse()
        assert response.status == 200
        response.read()
    started = time.monotonic()
    client = connection(url.hostname, url.port, timeout=3)
    clients.append(client)
    client.request("GET", "/health")
    response = client.getresponse()
    assert response.status == 200
    assert json.loads(response.read())["status"] in {"ready", "preparing"}
    assert time.monotonic() - started < 3
    print("PASS: three idle clients do not block the next HTTP request")
finally:
    for client in clients:
        client.close()

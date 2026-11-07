# Reproducible synthetic testing

Prerequisites: Node.js 22+, npm, and Docker with Compose v2. No particular OS, WSL distribution, personal server, vault, reverse proxy, or credentials are required.

```sh
npm ci
npm run verify
docker compose -p bettersync-test -f compose.test.yml up -d --wait
```

The Compose file creates CouchDB with an explicitly public test-only account, publishes only loopback, and mounts no host files. Never reuse the test account for real data. Set `BETTERSYNC_TEST_SERVER` to `http://127.0.0.1:15984` in the shell running tests:

```sh
# POSIX shell
export BETTERSYNC_TEST_SERVER=http://127.0.0.1:15984
```

```powershell
# PowerShell
$env:BETTERSYNC_TEST_SERVER='http://127.0.0.1:15984'
```

```sh
npm run test:integration
npm run benchmark:e2ee:sync -- 20 50 10
node --import tsx tests/transport-candidates.ts
docker compose -p bettersync-test -f compose.test.yml down -v
```

The suites create unique disposable databases and remove them afterward. `down -v` removes this Compose project's test containers and anonymous volumes; it does not target unrelated containers. If the example port is occupied, set `BETTERSYNC_TEST_PORT` before starting Compose and use the same port in `BETTERSYNC_TEST_SERVER`. No running container from the author's workstation is required.

GitHub Actions provisions its own synthetic CouchDB service on port 5984. Unit tests use generated fixtures and reserved example domains. Benchmark result files contain aggregate synthetic measurements; timings depend on the machine and are not reproducibility guarantees. Real Obsidian and physical-iPhone acceptance remain separate manual gates.

The integration script runs both historical schema-4 regressions and the current schema-5 three-client 88 MiB wire/restart/deletion test. The latter uses real CouchDB and a disk-backed host for the production Obsidian adapter, with lost acknowledgements injected around real HTTP. Tests create their own unique databases and always attempt cleanup.

Current synthetic chunk benchmarks (real crypto, serial engine, journal saves and disk staging; synthetic HTTP) are:

```sh
npm run benchmark:chunks -- large    # 8/32 MiB, 88 MB, 88 MiB, 200 MiB
npm run benchmark:chunks -- notes    # 1,000 notes, 0/50/100 ms added RTT
npm run benchmark:chunks -- latency  # 88 MiB, 50/100 ms added RTT
```

They assert exact SHA-256, chunk counts and payload bounds. Aggregate Node RSS includes the in-process server's retained ciphertext and test adapter copies; it is not plugin-only or iPhone peak memory. Results and the device handoff are in [CHUNKED-TRANSFER-VERIFICATION.md](CHUNKED-TRANSFER-VERIFICATION.md). On Windows, Docker may be run through WSL using the same Compose file; use the isolated loopback endpoint from the Windows test process.

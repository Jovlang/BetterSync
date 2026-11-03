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

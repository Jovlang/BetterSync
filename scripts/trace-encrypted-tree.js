/* Read-only diagnostic. Paste into Obsidian's developer console on each client.
 * Uses the running client's authenticated remote; never prints credentials,
 * recovery codes, plaintext bodies, plaintext digests or server addresses.
 * Output includes local paths and sizes. Review it before sharing.
 * No database writes, filesystem writes, checkpoints, or engine retries.
 */
(async () => {
  const plugin = app.plugins.plugins.bettersync;
  const engine = plugin?.engine;
  if (!engine?.remote || !engine?.vault || !engine?.store) {
    return JSON.stringify({error: 'An initialized encrypted BetterSync engine is required.'});
  }
  const remote = engine.remote, vault = engine.vault;
  const state = structuredClone(engine.store.state);
  const report = {version: plugin.manifest.version, status: plugin.status,
    pollScheduled: plugin.timer !== undefined, engineBlocked: engine.blocked,
    engineStopped: engine.stopped, cycleRunning: !!engine.running,
    sourceRows: 0, encryptedRecords: 0, rejectedRecords: 0, rows: []};
  const localPaths = await vault.listFiles();
  const docs = new Map();
  let since = 0;
  for (let page = 0; page < 10000; page++) {
    let changes;
    try { changes = await remote.getChanges(since); }
    catch { return JSON.stringify({...report, error: 'Changes-feed authentication/read failed.'}); }
    report.sourceRows += changes.sourceRows ?? changes.results.length;
    for (const row of changes.results) {
      if (!remote.ownsRecord(row.id)) continue;
      report.encryptedRecords++;
      try { const doc = await remote.validateIncoming(row.doc); docs.set(doc.path, doc); }
      catch { report.rejectedRecords++; }
    }
    if ((changes.sourceRows ?? changes.results.length) < 200) break;
    if (changes.last_seq === since || page === 9999) return JSON.stringify({...report,error:'Incomplete changes pagination.'});
    since = changes.last_seq;
  }
  const paths = [...new Set([...localPaths, ...docs.keys(), ...Object.keys(state.incoming)])].sort();
  for (const path of paths) {
    const doc = docs.get(path);
    const row = {path, scanned: localPaths.includes(path), baseline: !!state.files[path],
      journal: !!state.incoming[path], remote: !!doc,
      representation: doc?.encrypted?.inline !== undefined ? 'inline' : doc?.encrypted?._attachments ? 'attachment' : 'metadata',
      authenticatedContent: false, localExists: false, bytesEqual: false};
    const diskPath = path.endsWith('/') ? path.slice(0,-1) : path;
    let stat;
    try { stat = await app.vault.adapter.stat(diskPath); row.localExists = !!stat; }
    catch { row.failure = 'local-stat'; report.rows.push(row); continue; }
    if (!doc) { row.failure = 'missing-remote-record'; report.rows.push(row); continue; }
    let desired;
    try { desired = await remote.readContent(doc); row.authenticatedContent = true; }
    catch { row.failure = 'download-or-content-authentication'; report.rows.push(row); continue; }
    if (doc.deleted) row.bytesEqual = !stat;
    else if (path.endsWith('/')) row.bytesEqual = stat?.type === 'folder';
    else if (stat?.type === 'file') {
      try {
        const actual = new Uint8Array(await app.vault.adapter.readBinary(path));
        const expected = typeof desired === 'string' ? new TextEncoder().encode(desired) : new Uint8Array(desired);
        row.localBytes = actual.length; row.remoteBytes = expected.length;
        row.bytesEqual = actual.length === expected.length && actual.every((b,i) => b === expected[i]);
      } catch { row.failure = 'local-read'; }
    }
    if (!row.bytesEqual && !row.failure) row.failure = 'local-materialization-missing-or-different';
    report.rows.push(row);
  }
  report.localEntries = localPaths.length;
  report.equivalent = report.rejectedRecords === 0 && report.rows.every(row => row.bytesEqual);
  return JSON.stringify(report, null, 2);
})()

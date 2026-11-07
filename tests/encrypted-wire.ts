import assert from 'node:assert/strict';
import {EncryptedCouch} from '../src/legacy/encrypted-couch';
import {createConfiguration, generateRecoveryCode, importRecoveryCode, CONFIGURATION_ID, type VaultConfiguration} from '../src/legacy/encryption-setup';
import type {EncryptedRecord} from '../src/legacy/encrypted-protocol';
import type {Http} from '../src/couch-client';
import {syncPath} from '../src/paths';
export const connection = {url: 'https://wire.test/proxy', database: 'synthetic', username: 'test', password: 'test-only'};
export const input = (path = 'Private Æ/note.md', text = 'synthetic confidential contents') =>
  ({path, bytes: new TextEncoder().encode(text).buffer, deleted: false, mtime: 123456});
export class Wire {
  sequence = 0;
  history = new Map<string, {id:string;seq:number;doc:EncryptedRecord;changes:{rev:string}[]}>();
  records = new Map<string, EncryptedRecord>();
  bodies = new Map<string, ArrayBuffer>();
  requests: {url: string; method: string; body?: string | ArrayBuffer}[] = [];
  offline = false; loseResponse = false; status?: number; feed?: unknown; corruptBody = false;
  constructor(public configuration: VaultConfiguration) {}
  http: Http = async (url, method, headers, body, responseType) => {
    this.requests.push({url, method, body});
    if (this.offline) throw new Error('offline');
    if (this.status) return {status: this.status};
    if (url.includes('/_all_docs')) {
      const id = JSON.parse(body as string).keys[0] as string;
      const doc = id === CONFIGURATION_ID ? {...this.configuration, _rev: '1-config'} : this.records.get(id);
      return {status: 200, json: {rows: [doc ? {id, key: id, value: {rev: doc._rev}, doc}
        : {key: id, error: 'not_found'}]}};
    }
    if (url.includes('/_changes')) {
      const since=Number(new URL(url).searchParams.get('since')) || 0;
      const results=[...this.history.values()].filter(row=>row.seq>since).sort((a,b)=>a.seq-b.seq).slice(0,200);
      return {status:200,json:this.feed??{results,last_seq:results.at(-1)?.seq??this.sequence}};
    }
    const parsed = new URL(url), pieces = parsed.pathname.split('/'), id = decodeURIComponent(pieces.at(-1)!);
    if (method === 'GET') {
      assert.equal(responseType, 'binary');
      assert.equal(id, 'content');
      const docId = decodeURIComponent(pieces.at(-2)!);
      const bytes = this.bodies.get(docId + '@' + parsed.searchParams.get('rev'));
      if (!bytes) return {status: 404};
      const copy = bytes.slice(0);
      if (this.corruptBody) { const view = new Uint8Array(copy); view[0] = view[0]! ^ 1; }
      return {status: 200, arrayBuffer: copy};
    }
    assert.equal(method, 'PUT');
    let doc: EncryptedRecord, attachment: ArrayBuffer | undefined;
    if (body instanceof ArrayBuffer) {
      assert.match(headers['Content-Type']!, /^multipart\/related/);
      const raw = Buffer.from(body), metadataStart = raw.indexOf('\r\n\r\n') + 4;
      const metadataEnd = raw.indexOf('\r\n--', metadataStart);
      doc = JSON.parse(raw.subarray(metadataStart, metadataEnd).toString());
      const bodyStart = raw.indexOf('\r\n\r\n', metadataEnd) + 4;
      const length = doc._attachments!.content.length;
      attachment = new Uint8Array(raw.subarray(bodyStart, bodyStart + length)).buffer;
      assert.equal((doc._attachments!.content as unknown as {follows: boolean}).follows, true);
      doc._attachments = {content: {stub: true, content_type: 'application/octet-stream', length}};
    } else doc = JSON.parse(body as string);
    assert.equal(doc._id, id);
    const old = this.records.get(id);
    if (old?._rev !== doc._rev) return {status: 409};
    const rev = `${old ? Number(old._rev!.split('-')[0]) + 1 : 1}-saved`;
    const saved = {...doc, _rev: rev}; this.records.set(id, saved);
    this.history.set(id,{id,seq:++this.sequence,doc:structuredClone(saved),changes:[{rev}]});
    if (attachment) this.bodies.set(id + '@' + rev, attachment);
    if (this.loseResponse) { this.loseResponse = false; throw new Error('accepted but response lost'); }
    return {status: 201, json: {ok: true, id, rev}};
  };
}
export async function fixture() {
  const code = generateRecoveryCode(), crypto = await importRecoveryCode(code);
  const wire = new Wire(await createConfiguration(crypto));
  const connect = async () => EncryptedCouch.connect(connection, wire.http, await importRecoveryCode(code), syncPath);
  return {code, crypto, wire, connect, client: await connect()};
}


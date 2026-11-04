# Schema 4 transport evaluation

Status: evaluation in progress; schema 4 is NOT frozen. Unrelated E2EE work is paused.

The architecture criterion is avoiding per-file RTT scaling for ordinary small files while preserving one engine, authenticated content, durable journals and bounded memory. Earlier fixed millisecond UX targets in E2EE-PLAN.md are superseded by this criterion.

The isolated experiment in tests/transport-candidates.ts compares attachment-only encryption and 16/64/256 KiB inline bounds with a plaintext baseline. Thresholds apply to plaintext byte length, irrespective of extension. This is an experimental database layout, not a production codec or an accepted schema. It uses the same encrypted content bytes, but reconstructs the original attachment envelope locally for decryption; therefore it does NOT validate final representation binding, journal semantics or the freeze security tests.

The runner seeds 1,000 deterministic notes (0, 512, 2,048, 8,192 and 32,768 bytes) and measures 20/200/1,000-file downloads at 0/50/100 ms added request latency. It uses paginated keyed all_docs rather than changes: equivalent inline/stub body shape, but not a measured production changes feed. Setup/upload and authentication/bootstrap requests are excluded. Each case has one trial. Reported bytes are response bodies, excluding HTTP headers and upload traffic. cryptoMs includes metadata validation, hashing and decryption. RSS is an endpoint observation, not peak memory; fixture buffers remain resident. These figures are not mobile measurements.

Raw aggregate results are transport-candidates.jsonl and transport-plaintext.jsonl. Plaintext baseline ran while the encrypted experiment was in progress, so absolute timings are exploratory and may contain contention. Request-count scaling is the primary evidence.

A 16 KiB bound leaves one fifth of this distribution as attachments. A 64 KiB bound covers all these ordinary files. The 256 KiB bound has no request-count advantage for this distribution and raises the theoretical 200-record inline ciphertext ceiling from approximately 16.7 MiB to 66.7 MiB after base64, before metadata, JSON strings, parsed objects, crypto buffers and journal copies. Larger-file and near-threshold fixtures must be measured before selecting a final bound.

No engine changes have been made for this experiment. Production implementation must authenticate representation choice or enforce a deterministic threshold after metadata decryption, reject both/missing representations, retain exact-revision attachment reads and run wrong-key/tamper/substitution/recovery tests for both layouts. Final encoding and threshold will be documented only after that implementation is validated. Physical-iPhone encrypted large-file tests remain an explicit freeze/release blocker; the 200 MiB protocol limit is not demonstrated mobile support.

## Measured architectural result

All 36 encrypted cases and nine plaintext cases completed against CouchDB 3.5. At 100 ms added latency:

| Layout | 20 files: requests / seconds | 200 files | 1,000 files | 1,000-file response bytes | Largest page bytes |
|---|---|---|---|---:|---:|
| Attachments | 21 / 2.277 | 201 / 21.859 | 1,005 / 109.288 | 9,603,225 | 176,645 |
| 16 KiB | 5 / 0.542 | 41 / 4.508 | 205 / 22.469 | 10,216,625 | 731,965 |
| 64 KiB | 1 / 0.129 | 1 / 0.205 | 5 / 1.044 | 12,374,825 | 2,474,965 |
| 256 KiB | 1 / 0.120 | 1 / 0.198 | 5 / 1.020 | 12,374,825 | 2,474,965 |

Plaintext required five requests and about 0.676 seconds for 1,000 files at 100 ms added latency, with 9,353,558 response bytes. The 64 KiB candidate removes the observed per-file RTT scaling at approximately 29% more response bytes than attachment-only encryption for this workload. 16 KiB still has per-file scaling for 32 KiB notes. 256 KiB offers no architectural advantage on the measured distribution.

Recommendation from this experiment: implement and validate a fixed 64 KiB plaintext-size hybrid candidate, with no extension discriminator or user setting. This is evidence for the representation direction, not a completed production implementation or schema freeze. Required next evidence includes threshold-boundary and medium-file distributions, actual changes-feed pages, journal amplification/peak memory, both-representation security/recovery tests, real CouchDB integration of the final codec, and physical iPhone behavior. Existing production code remains attachment-only pending that work.

## Hybrid implementation — 4 November 2026

Selected candidate: files of 0 through 65,536 plaintext bytes inclusive use the top-level inline field, canonical unpadded base64url of the AES-GCM content ciphertext including its 16-byte tag. Larger files use the existing encrypted content attachment; directories and deletion markers have neither. No file extension influences this choice. The authenticated metadata size enforces this deterministic rule after decryption, rejecting moved, missing or simultaneous representations. The same per-write key derivation, content nonce, AAD, digest and validation apply to both. The engine has no representation branch. Inline ciphertext remains in the durable encrypted incoming envelope, so repeated state cloning/save amplification and iPhone peak memory still need measurement. The maximum individual inline string is 87,403 characters.

Verification: 138 automated tests pass, including both-representation boundary/wrong-key/tamper/substitution checks, independent crypto interoperability, three-client conflicts and crash replay. Both real CouchDB integration tests pass. Schema 4 is NOT frozen: physical-iPhone encrypted large-file validation and the remaining memory/security acceptance checks are outstanding. Earlier draft databases have no compatibility guarantee; recreate test databases.

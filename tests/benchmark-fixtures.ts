/** Synthetic, deterministic fixtures shared by codec and future device/wire benchmarks. */
export const SMALL_NOTE_COUNTS = [20, 100, 1000, 10000] as const;
const sizes = [0, 512, 2048, 8192, 32768];
export function* smallNotes(count: number): Generator<{path: string; bytes: ArrayBuffer}> {
  if (!Number.isSafeInteger(count) || count < 1 || count > 10000) throw new Error('Invalid fixture count.');
  for (let i = 0; i < count; i++) {
    const bytes = new Uint8Array(sizes[i % sizes.length]!);
    // ASCII content ensures the declared UTF-8 byte sizes are exact.
    for (let j = 0; j < bytes.length; j++) bytes[j] = j % 80 === 79 ? 10 : 32 + ((i * 17 + j * 13) % 95);
    yield {path: `Synthetic/${i % 10}/Norsk-Æ-${String(i).padStart(5, '0')}.md`, bytes: bytes.buffer};
  }
}

import { execFileSync } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const dir = await mkdtemp(path.join(os.tmpdir(), "go7-workhorse-media-smoke."));
const files = {
  image: path.join(dir, "marker.png"),
  file: path.join(dir, "fixture.txt"),
  document: path.join(dir, "brief.pdf"),
  audio: path.join(dir, "note.wav"),
  video: path.join(dir, "demo.mp4"),
};

await writeFile(files.image, Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Z3f8AAAAASUVORK5CYII=", "base64"));
await writeFile(files.file, "FILE_MARKER_731\n", "utf8");
await writeFile(files.document, Buffer.from("JVBERi0xLjQKMSAwIG9iajw8L1R5cGUvQ2F0YWxvZy9QYWdlcyAyIDAgUj4+ZW5kb2JqCjIgMCBvYmo8PC9UeXBlL1BhZ2VzL0NvdW50IDAvS2lkc1tdPj5lbmRvYmoKdHJhaWxlcjw8L1Jvb3QgMSAwIFI+PgolJUVPRgo=", "base64"));

const samples = 8_000;
const wav = Buffer.alloc(44 + samples * 2);
wav.write("RIFF", 0);
wav.writeUInt32LE(wav.length - 8, 4);
wav.write("WAVEfmt ", 8);
wav.writeUInt32LE(16, 16);
wav.writeUInt16LE(1, 20);
wav.writeUInt16LE(1, 22);
wav.writeUInt32LE(8_000, 24);
wav.writeUInt32LE(16_000, 28);
wav.writeUInt16LE(2, 32);
wav.writeUInt16LE(16, 34);
wav.write("data", 36);
wav.writeUInt32LE(samples * 2, 40);
for (let index = 0; index < samples; index += 1) {
  wav.writeInt16LE(Math.round(Math.sin(index * Math.PI / 20) * 1_000), 44 + index * 2);
}
await writeFile(files.audio, wav);

execFileSync("ffmpeg", [
  "-loglevel", "error", "-y", "-f", "lavfi", "-i", "color=c=0x7037ff:s=160x90:d=1",
  "-vf", "format=yuv420p", "-movflags", "+faststart", files.video,
]);

console.log(JSON.stringify({ dir, files }, null, 2));

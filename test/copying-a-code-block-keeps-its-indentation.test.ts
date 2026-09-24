import assert from "node:assert/strict";
import test from "node:test";
import { copyText } from "../src/lib/copy-text";

async function copied(text: string): Promise<{ ok: boolean; written: string[] }> {
  const written: string[] = [];
  const before = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: { clipboard: { writeText: async (value: string) => void written.push(value) } },
  });
  try {
    return { ok: await copyText(text), written };
  } finally {
    if (before) Object.defineProperty(globalThis, "navigator", before);
    else delete (globalThis as { navigator?: unknown }).navigator;
  }
}

test("copying a code block keeps the first line's indentation", async () => {
  // Copy trimmed the whole block, so an indented snippet lost the indent on its
  // first line and pasted back as broken Python.
  const block = "    def run(self):\n        return 1";
  assert.deepEqual(await copied(block), { ok: true, written: [block] });
  assert.deepEqual(await copied("\n\n  key: value\n  other: 2\n\n"), { ok: true, written: ["  key: value\n  other: 2"] });
});

test("copying a reply still drops blank edges, and blank text copies nothing", async () => {
  assert.deepEqual(await copied("\nDone.\n"), { ok: true, written: ["Done."] });
  assert.deepEqual(await copied("   \n\t"), { ok: false, written: [] });
});

import assert from "node:assert/strict";
import test from "node:test";
import { isSettingsSection, normalizeSettings } from "../src/lib/settings";
import { DEFAULT_WORKSHOP_SETTINGS } from "../src/lib/workshop";

test("workshop grants persist fail-closed and are not a Settings section", () => {
  assert.equal(isSettingsSection("workshop"), false);
  assert.equal(isSettingsSection("skills"), true);
  const settings = normalizeSettings({
    workshop: {
      packs: [
        { id: "box-monitor", on: true, grants: ["read.box.metrics", "read.box.metrics", "write.box", "kill.train"] },
        { id: "Nope", on: true, grants: ["read.job.log"] },
      ],
    },
  });
  assert.deepEqual(settings.workshop, {
    packs: [{ id: "box-monitor", on: true, grants: ["read.box.metrics"] }],
  });
  assert.deepEqual(normalizeSettings({}).workshop, DEFAULT_WORKSHOP_SETTINGS);
});

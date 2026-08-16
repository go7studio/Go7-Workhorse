---
name: ship-go7-godot-play
description: Implement, repair, or certify Google Play Billing and Android closed-testing builds for Go7 Godot games. Use for Godot Play Billing plugins, non-consumable entitlements, purchase or restore flows, Gradle Android exports, APK/AAB inspection, licensed-tester readiness, or Play packaging evidence. Do not use for Flutter, iOS StoreKit, ASO, or store-listing copy.
---

# Ship Go7 Godot Play

## Scope

Ship a real Godot Android billing integration with artifact evidence. Never confuse an adapter seam or successful export with a packaged, callable billing plugin.

## Workflow

1. Read the repository instructions, release plan, monetization contract, current export preset, entitlement code, and tests.
2. Check the exact Godot version and current official plugin compatibility using primary sources. Use only the official `godot-sdk-integrations/godot-google-play-billing` repository or its documented successor. Verify release assets and published hashes when available. Never vendor an unrelated AAR.
3. Inspect the existing addon, Gradle template, product ID, package ID, version name/code, signing mode, and Play Console dependencies before editing.
4. Add tests around a fake billing client before changing the adapter. Cover product filtering, pending, purchased-unacknowledged, acknowledgment success/failure, restore, disconnect, malformed payloads, and cache safety.
5. Install the complete official addon under `addons/GodotGooglePlayBilling`, enable its editor/export plugin, and enable the Gradle Android build. Match the adapter to the installed release API; do not assume old method or response names.
6. Keep the platform store authoritative. Grant `full` only after the intended non-consumable is purchased and acknowledged. Pending, cancelled, failed, wrong-product, malformed, or unacknowledged results never grant. Restore must query Play independently of the progression save.
7. Run the complete headless and end-to-end suites. Export the Android artifact and verify its package, version, signature, and hash.
8. Inspect the APK/AAB contents. Require the Godot billing plugin class, Godot v2 plugin metadata, `com.android.vending.BILLING`, and the Google Billing Client dependency. Export success alone is insufficient.
9. Run a non-purchase physical-device launch smoke when authorized. A real purchase or restore requires an installed licensed-testing build and explicit authority; never change Play Console, accounts, payments, rollout, or release state by inference.
10. Commit only source, official addon files, tests, config, and concise evidence. Exclude generated Gradle trees, APK/AAB files, device logs, and editor-generated IDs unless the repository intentionally tracks them.

## Completion gate

Report separately:

- implemented and unit-proven;
- packaged and artifact-proven;
- device launch-proven;
- Play licensed-tester purchase/restore-proven;
- human-only or externally blocked.

Do not mark the task complete when the addon is absent, the artifact lacks the plugin, or the only proof is a mock. Preserve prior evidence and block with the exact missing external requirement.

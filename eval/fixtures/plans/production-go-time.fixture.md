<!-- workhorse-plan-id: production-go-time -->
# Production Go-Time

### Task 1: Visual audit

- depends: none
- capability: vision, image, computer-use
- preferred-profile: custom-kimi
- preferred-model: Kimi-K3
- acceptance: Capture icon, UI, and UX findings with image evidence.

### Task 2: Implement approved repairs

- depends: task-001
- capability: repository, code, tests
- preferred-profile: grok-acp
- preferred-model: grok-4.6
- acceptance: Commit only approved changes and keep tests green.

### Task 3: Android recert

- depends: task-002
- capability: godot, adb, android-device
- preferred-profile: grok-acp
- preferred-model: grok-4.6
- watch-fallback-profile: custom-openai
- watch-fallback-model: MiniMax-M3
- acceptance: Record capability evidence before any install or launch action.

### Task 4: iOS recert

- depends: task-002
- capability: godot, ios-simulator
- preferred-profile: custom-openai
- preferred-model: MiniMax-M3
- peer-target: ios-review-session
- acceptance: Correlate simulator evidence with the orchestrator task.

### Task 5: Godot editor recert

- depends: task-002
- capability: godot, godot-ui
- preferred-profile: custom-openai
- preferred-model: MiniMax-M3
- acceptance: Record the editor capability and a bounded UI result.

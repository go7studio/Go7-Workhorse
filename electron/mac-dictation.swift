import AVFoundation
import Foundation
import Speech

func emit(_ payload: [String: Any]) {
  guard JSONSerialization.isValidJSONObject(payload),
        let data = try? JSONSerialization.data(withJSONObject: payload),
        let line = String(data: data, encoding: .utf8) else { return }
  fputs(line + "\n", stdout)
  fflush(stdout)
}

final class DeskDictation {
  private let recognizer: SFSpeechRecognizer
  private let engine = AVAudioEngine()
  private let queue = DispatchQueue(label: "workhorse.dictation")
  private var request: SFSpeechAudioBufferRecognitionRequest?
  private var task: SFSpeechRecognitionTask?
  private var committed = ""
  private var listening = false
  private var lastLevel = Date.distantPast

  init(recognizer: SFSpeechRecognizer) {
    self.recognizer = recognizer
  }

  func start() throws {
    let input = engine.inputNode
    let format = input.outputFormat(forBus: 0)
    guard format.sampleRate > 0, format.channelCount > 0 else {
      throw NSError(
        domain: "workhorse.dictation",
        code: 1,
        userInfo: [NSLocalizedDescriptionKey: "The microphone has no audio format."]
      )
    }
    input.removeTap(onBus: 0)
    input.installTap(onBus: 0, bufferSize: 1024, format: format) { [weak self] buffer, _ in
      self?.request?.append(buffer)
      self?.emitLevel(buffer)
    }
    engine.prepare()
    try engine.start()
    listen()
    emit(["type": "ready"])
  }

  private func listen() {
    queue.async {
      guard !self.listening else { return }
      self.listening = true
      self.task?.cancel()
      let next = SFSpeechAudioBufferRecognitionRequest()
      next.shouldReportPartialResults = true
      if #available(macOS 13, *) {
        next.addsPunctuation = true
      }
      self.request = next
      self.task = self.recognizer.recognitionTask(with: next) { [weak self] result, error in
        self?.handle(result: result, error: error)
      }
    }
  }

  private func handle(result: SFSpeechRecognitionResult?, error: Error?) {
    if let result {
      let text = joined(result.bestTranscription.formattedString)
      emit(["type": result.isFinal ? "final" : "partial", "text": text])
      if result.isFinal {
        committed = text
        scheduleRestart()
        return
      }
    }
    guard let error else { return }
    let ns = error as NSError
    if ns.code == 216 || ns.code == 301 { return }
    if ns.domain == "kAFAssistantErrorDomain" && (ns.code == 1110 || ns.code == 203 || ns.code == 209) {
      scheduleRestart()
      return
    }
    emit(["type": "error", "message": ns.localizedDescription])
  }

  private func scheduleRestart() {
    queue.asyncAfter(deadline: .now() + 0.2) {
      self.listening = false
      self.task = nil
      self.request = nil
      self.listen()
    }
  }

  private func joined(_ current: String) -> String {
    let piece = current.trimmingCharacters(in: .whitespacesAndNewlines)
    if piece.isEmpty { return committed }
    if committed.isEmpty { return piece }
    if committed.hasSuffix("\n") || committed.hasSuffix(" ") { return committed + piece }
    return committed + " " + piece
  }

  private func emitLevel(_ buffer: AVAudioPCMBuffer) {
    guard let samples = buffer.floatChannelData?.pointee else { return }
    let count = Int(buffer.frameLength)
    if count == 0 { return }
    let now = Date()
    if now.timeIntervalSince(lastLevel) < 0.1 { return }
    lastLevel = now
    var sum: Float = 0
    for index in 0..<count {
      let sample = samples[index]
      sum += sample * sample
    }
    let rms = sqrt(sum / Float(count))
    let level = min(1, max(0, Double(rms) * 8))
    emit(["type": "level", "value": level])
  }
}

let recognizer = SFSpeechRecognizer(locale: Locale.current) ?? SFSpeechRecognizer(locale: Locale(identifier: "en-US"))
guard let recognizer, recognizer.isAvailable else {
  emit(["type": "error", "message": "Speech recognition is not available on this Mac."])
  exit(1)
}

let auth = DispatchSemaphore(value: 0)
var speechAllowed = false
SFSpeechRecognizer.requestAuthorization { status in
  speechAllowed = status == .authorized
  auth.signal()
}
auth.wait()
guard speechAllowed else {
  emit([
    "type": "error",
    "message": "Speech recognition is off. Allow it in System Settings, then try the mic again.",
    "openSettings": true,
  ])
  exit(2)
}

let mic = DispatchSemaphore(value: 0)
var micAllowed = false
if #available(macOS 14, *) {
  AVAudioApplication.requestRecordPermission { granted in
    micAllowed = granted
    mic.signal()
  }
} else {
  micAllowed = true
  mic.signal()
}
mic.wait()
guard micAllowed else {
  emit([
    "type": "error",
    "message": "The microphone is off. Allow it in System Settings, then try the mic again.",
    "openSettings": true,
  ])
  exit(3)
}

let desk = DeskDictation(recognizer: recognizer)
do {
  try desk.start()
} catch {
  emit(["type": "error", "message": error.localizedDescription])
  exit(1)
}
dispatchMain()

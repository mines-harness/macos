import AVFoundation
import Foundation
import Speech

private var current: DictationSession?
private var response: UnsafeMutablePointer<CChar>?

private func encode(_ value: [String: Any]) -> UnsafePointer<CChar>? {
    if let previous = response { free(previous) }
    let data = (try? JSONSerialization.data(withJSONObject: value, options: [.sortedKeys])) ?? Data()
    response = strdup(String(data: data, encoding: .utf8) ?? "{}")
    return response.map { UnsafePointer($0) }
}

private final class DictationSession {
    let id: String
    let recognizer: SFSpeechRecognizer?
    var phase = "preparing"
    var transcript = ""
    var error: String?
    private let engine = AVAudioEngine()
    private var request: SFSpeechAudioBufferRecognitionRequest?
    private var task: SFSpeechRecognitionTask?
    private var tapped = false

    init(id: String, locale: String) {
        self.id = id
        recognizer = SFSpeechRecognizer(locale: Locale(identifier: locale))
    }

    var terminal: Bool { ["finished", "cancelled", "error"].contains(phase) }

    func prepare() {
        guard let recognizer, recognizer.supportsOnDeviceRecognition else {
            fail("On-device speech recognition is not installed for this language.")
            return
        }
        SFSpeechRecognizer.requestAuthorization { [weak self] status in
            DispatchQueue.main.async {
                guard let self, !self.terminal else { return }
                guard status == .authorized else {
                    self.fail("Allow Speech Recognition for mines in System Settings.")
                    return
                }
                AVCaptureDevice.requestAccess(for: .audio) { granted in
                    DispatchQueue.main.async {
                        guard !self.terminal else { return }
                        guard granted else {
                            self.fail("Allow Microphone access for mines in System Settings.")
                            return
                        }
                        self.capture()
                    }
                }
            }
        }
    }

    private func capture() {
        guard let recognizer, !terminal else { return }
        let request = SFSpeechAudioBufferRecognitionRequest()
        request.requiresOnDeviceRecognition = true
        request.shouldReportPartialResults = true
        request.taskHint = .dictation
        self.request = request
        let input = engine.inputNode
        let format = input.outputFormat(forBus: 0)
        guard format.channelCount > 0, format.sampleRate > 0 else {
            fail("No microphone is available.")
            return
        }
        input.installTap(onBus: 0, bufferSize: 1024, format: format) { buffer, _ in
            request.append(buffer)
        }
        tapped = true
        task = recognizer.recognitionTask(with: request) { [weak self] result, recognitionError in
            DispatchQueue.main.async {
                guard let self, !self.terminal else { return }
                if let result { self.transcript = result.bestTranscription.formattedString }
                if result?.isFinal == true {
                    self.complete()
                } else if recognitionError != nil {
                    if self.phase == "finishing", !self.transcript.isEmpty {
                        self.complete()
                    } else {
                        self.fail("Speech recognition stopped. Check your microphone and speech language.")
                    }
                }
            }
        }
        do {
            engine.prepare()
            try engine.start()
            phase = "recording"
        } catch {
            fail("Could not start the microphone.")
        }
    }

    func stop(cancel: Bool) {
        guard !terminal else { return }
        stopAudio()
        if cancel {
            phase = "cancelled"
            transcript = ""
            task?.cancel()
            task = nil
            request = nil
        } else {
            phase = "finishing"
            request?.endAudio()
            task?.finish()
            DispatchQueue.main.asyncAfter(deadline: .now() + 3) { [weak self] in
                guard let self, self.phase == "finishing" else { return }
                self.complete()
            }
        }
    }

    private func stopAudio() {
        engine.stop()
        if tapped {
            engine.inputNode.removeTap(onBus: 0)
            tapped = false
        }
    }

    private func complete() {
        phase = "finished"
        stopAudio()
        task?.cancel()
        task = nil
        request = nil
    }

    private func fail(_ message: String) {
        phase = "error"
        error = message
        transcript = ""
        stopAudio()
        task?.cancel()
        task = nil
        request = nil
    }
}

@_cdecl("mines_dictation_capability")
public func capability(_ locale: UnsafePointer<CChar>) -> UnsafePointer<CChar>? {
    let language = String(cString: locale)
    let available = SFSpeechRecognizer(locale: Locale(identifier: language))?.supportsOnDeviceRecognition == true
    return encode([
        "available": available,
        "locale": language,
        "reason": available ? NSNull() : "On-device speech recognition is not installed for this language." as Any,
    ])
}

@_cdecl("mines_dictation_start")
public func start(_ id: UnsafePointer<CChar>, _ locale: UnsafePointer<CChar>) {
    let session = DictationSession(id: String(cString: id), locale: String(cString: locale))
    current?.stop(cancel: true)
    current = session
    session.prepare()
}

@_cdecl("mines_dictation_stop")
public func stop(_ cancel: Int32) {
    current?.stop(cancel: cancel != 0)
    if cancel != 0 { current = nil }
}

@_cdecl("mines_dictation_snapshot")
public func snapshot() -> UnsafePointer<CChar>? {
    guard let current else { return encode([:]) }
    return encode([
        "sessionId": current.id,
        "phase": current.phase,
        "transcript": current.phase == "finished" ? current.transcript : "",
        "error": current.error as Any? ?? NSNull(),
    ])
}

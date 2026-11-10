import AVFoundation
import Foundation
import NaturalLanguage
import Observation

/// Reads Blob's answers aloud in text mode, with Apple's Premium or Enhanced
/// voices only. Apps can't use the current Siri voices, and the basic voices
/// sound robotic, so with no good voice for the answer's language Blob stays
/// silent and shows the text.
@MainActor
@Observable
final class BlobSpeaker: NSObject {
    static let readAloudKey = "blob.readAloud"
    static let voiceKey = "blob.voice"
    static let liveCallKey = "blob.liveCall"
    /// Ava (Premium), then Aaron (Enhanced), then Zoe (Premium).
    static let preferredDefaults = [
        "com.apple.voice.premium.en-US.Ava",
        "com.apple.ttsbundle.siri_Aaron_en-US_premium",
        "com.apple.voice.premium.en-US.Zoe",
    ]

    private(set) var speaking = false
    private var lastWord = Date.distantPast
    private let synthesizer = AVSpeechSynthesizer()

    override init() {
        super.init()
        synthesizer.delegate = self
    }

    /// Voice pulse for Blob: a beat on every word, fading between words.
    func level(at date: Date) -> Double {
        guard speaking else { return 0 }
        return max(0, 0.8 - date.timeIntervalSince(lastWord) * 3)
    }

    /// Speaks `text` if reading aloud is on and a good voice exists for its
    /// language. Returns whether it is speaking.
    @discardableResult
    func speak(_ text: String) -> Bool {
        guard UserDefaults.standard.object(forKey: Self.readAloudKey) as? Bool ?? true else { return false }
        let plain = Self.plain(text)
        guard !plain.isEmpty, let voice = Self.voice(for: plain) else { return false }
        try? BlobListener.activateSession(record: false)
        let utterance = AVSpeechUtterance(string: plain)
        utterance.voice = voice
        synthesizer.stopSpeaking(at: .immediate)
        synthesizer.speak(utterance)
        speaking = true
        return true
    }

    func preview(_ voice: AVSpeechSynthesisVoice) {
        try? BlobListener.activateSession(record: false)
        let utterance = AVSpeechUtterance(string: "Hi, I\u{2019}m Blob. I\u{2019}ll be here when something needs you.")
        utterance.voice = voice
        synthesizer.stopSpeaking(at: .immediate)
        synthesizer.speak(utterance)
        speaking = true
    }

    func stop() {
        synthesizer.stopSpeaking(at: .immediate)
        speaking = false
    }

    // MARK: Voices

    /// Installed voices good enough to use: Premium and Enhanced only.
    static func goodVoices() -> [AVSpeechSynthesisVoice] {
        AVSpeechSynthesisVoice.speechVoices()
            .filter { $0.quality == .premium || $0.quality == .enhanced }
            .sorted { ($0.quality.rawValue, $0.name) > ($1.quality.rawValue, $1.name) }
    }

    /// The chosen voice when it speaks the answer's language; otherwise the
    /// best good voice that does; otherwise none.
    static func voice(for text: String) -> AVSpeechSynthesisVoice? {
        let language = NLLanguageRecognizer.dominantLanguage(for: text)?.rawValue ?? "en"
        let good = goodVoices().filter { $0.language.hasPrefix(language) }
        let chosen = UserDefaults.standard.string(forKey: voiceKey)
        if let chosen, let voice = good.first(where: { $0.identifier == chosen }) { return voice }
        for id in preferredDefaults { if let voice = good.first(where: { $0.identifier == id }) { return voice } }
        return good.first
    }

    /// The voice the settings show as selected.
    static func selectedVoice() -> AVSpeechSynthesisVoice? {
        let good = goodVoices()
        let chosen = UserDefaults.standard.string(forKey: voiceKey)
        return good.first { $0.identifier == chosen }
            ?? preferredDefaults.lazy.compactMap { id in good.first { $0.identifier == id } }.first
            ?? good.first
    }

    /// Markdown read aloud sounds like punctuation; speak the words only.
    static func plain(_ markdown: String) -> String {
        var s = markdown
        s = s.replacingOccurrences(of: #"```[\s\S]*?```"#, with: "", options: .regularExpression)
        s = s.replacingOccurrences(of: #"\[([^\]]+)\]\([^)]+\)"#, with: "$1", options: .regularExpression)
        s = s.replacingOccurrences(of: #"(?m)^\s*([#>]+|[-*+]|\d+\.)\s+"#, with: "", options: .regularExpression)
        s = s.replacingOccurrences(of: #"[*_`~|]"#, with: "", options: .regularExpression)
        return s.trimmingCharacters(in: .whitespacesAndNewlines)
    }
}

extension BlobSpeaker: AVSpeechSynthesizerDelegate {
    nonisolated func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, willSpeakRangeOfSpeechString characterRange: NSRange, utterance: AVSpeechUtterance) {
        Task { @MainActor in self.lastWord = Date() }
    }

    nonisolated func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didFinish utterance: AVSpeechUtterance) {
        Task { @MainActor in self.speaking = false }
    }

    nonisolated func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didCancel utterance: AVSpeechUtterance) {
        Task { @MainActor in self.speaking = false }
    }
}

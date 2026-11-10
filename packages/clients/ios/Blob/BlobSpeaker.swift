import AVFoundation
import Foundation
import NaturalLanguage
import Observation

/// Reads aloud what Blob says in text mode: an answer's spoken script, or the
/// first paragraph of a decision (`BlobReply.spoken`), never what is shown.
/// A reply is read segment by segment (`BlobSegment`), one request and one
/// playback item each; when a segment with a cue starts playing, `onCue`
/// says which shown element to focus. A delivery hint (`[warm]`) goes to the
/// server voice as direction and is left out for an Apple voice. When the server has a Fish Audio
/// key (`GET /api/blob/speech/status`), the server voice reads every answer,
/// Polish included. Otherwise, or when a request fails, Apple's Premium or
/// Enhanced voices read it. Apps can't use the current Siri voices, and the
/// basic voices sound robotic, so with no good Apple voice for the answer's
/// language Blob stays silent and shows the text.
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
    /// Longest piece sent to the server voice at once, after the first
    /// sentence. Longer pieces read more naturally; the first one is a single
    /// sentence so speech starts fast.
    static let serverPieceChars = 280

    private(set) var speaking = false
    /// The server voice as last reported; nil until asked.
    private(set) var server: OS1API.BlobSpeechStatus?
    private var serverCheckedAt = Date.distantPast
    private var lastWord = Date.distantPast
    private let synthesizer = AVSpeechSynthesizer()
    private var player: AVAudioPlayer?
    private var finished: CheckedContinuation<Void, Never>?
    private var serverTask: Task<Void, Never>?
    /// The utterance being spoken, so a late callback from a stopped one
    /// can't end a newer answer.
    private var utteranceId: ObjectIdentifier?
    private var utteranceDone: CheckedContinuation<Void, Never>?

    /// Sentences of a streaming answer waiting to be read, in order. Each
    /// one's server audio is requested ahead (`queueAhead`), so the next is
    /// ready when the current one ends.
    private var queue: [Queued] = []
    private var queueTask: Task<Void, Never>?
    /// Sentences of a reply are being read (`enqueue`).
    var readingReply: Bool { queueTask != nil }
    /// Audio requests kept in flight ahead of playback.
    static let queueAhead = 2
    /// A server request for this reply failed (a 429, say): the rest of it
    /// is read with an Apple voice and asks the server for nothing more.
    /// Cleared by `stop`, which every new reply starts with.
    private var appleForReply = false

    private struct Queued {
        let text: String
        let cue: String?
        var audio: Task<Data, Error>?
    }

    /// Called when a segment with a cue starts playing, with the cue's id.
    @ObservationIgnored var onCue: ((String) -> Void)?

    override init() {
        super.init()
        synthesizer.delegate = self
    }

    /// Voice pulse for Blob: a beat on every word with an Apple voice, the
    /// player's loudness with the server voice.
    func level(at date: Date) -> Double {
        guard speaking else { return 0 }
        if let player, player.isPlaying {
            player.updateMeters()
            let power = Double(player.averagePower(forChannel: 0))
            return min(0.9, max(0, (power + 42) / 36))
        }
        return max(0, 0.8 - date.timeIntervalSince(lastWord) * 3)
    }

    /// Whether answers go to the server voice.
    var usesServerVoice: Bool { server?.configured == true }

    /// Asks the server whether it has a voice. Cached for a few minutes;
    /// `force` asks again. A failed check keeps the last answer.
    @discardableResult
    func refreshServerVoice(force: Bool = false) async -> OS1API.BlobSpeechStatus? {
        guard force || server == nil || Date().timeIntervalSince(serverCheckedAt) > 300 else { return server }
        guard ServerConfig.shared.isConfigured else { return nil }
        if let status = try? await OS1API.blobSpeechStatus() {
            server = status
            serverCheckedAt = Date()
        }
        return server
    }

    func setServerModel(_ model: String) async throws {
        server = try await OS1API.setBlobSpeechModel(model)
        serverCheckedAt = Date()
    }

    /// Speaks `text` if reading aloud is on: with the server voice when the
    /// server has one, else with a good Apple voice for its language.
    /// Returns whether it is speaking.
    @discardableResult
    func speak(_ text: String) -> Bool {
        guard UserDefaults.standard.object(forKey: Self.readAloudKey) as? Bool ?? true else { return false }
        let plain = Self.plain(text)
        guard !plain.isEmpty else { return false }
        stop()
        // Unknown yet: ask first, then pick. A server without the route is
        // simply not configured.
        if server?.configured != false, ServerConfig.shared.isConfigured {
            speaking = true
            serverTask = Task { await speakOnServer(plain) }
            return true
        }
        return speakWithApple(plain)
    }

    /// Adds segments of a streaming answer to what Blob reads, if reading
    /// aloud is on. They play in order, each right after the last, one
    /// request and one playback item per segment, so a cue fires exactly
    /// when its words start; their server audio is requested at once, up to
    /// `queueAhead` at a time. Once a request fails, the rest of the reply is
    /// read with an Apple voice. Only a reply calls this, so it cuts off
    /// anything `speak` was reading (a decision); `stop` clears the queue.
    func enqueue(_ segments: [BlobSegment]) {
        guard UserDefaults.standard.object(forKey: Self.readAloudKey) as? Bool ?? true else { return }
        let items = segments.compactMap { segment -> Queued? in
            let text = Self.plain(segment.text)
            return text.isEmpty ? nil : Queued(text: text, cue: segment.cue)
        }
        guard !items.isEmpty else { return }
        if queueTask == nil { cutOff() }
        queue.append(contentsOf: items)
        speaking = true
        if usesServerVoice, !appleForReply { requestAhead() }
        if queueTask == nil { queueTask = Task { await readQueue() } }
    }

    /// Starts the server requests for the next `queueAhead` sentences.
    private func requestAhead() {
        for index in queue.indices.prefix(Self.queueAhead) where queue[index].audio == nil {
            queue[index].audio = Self.fetch(queue[index].text)
        }
    }

    /// Reads the queue until it is empty. Returns at once when stopped: a
    /// newer queue may already be running.
    private func readQueue() async {
        var useServer = false
        if server?.configured != false, ServerConfig.shared.isConfigured {
            useServer = await refreshServerVoice()?.configured == true
            if Task.isCancelled { return }
        }
        try? BlobListener.activateSession(record: false)
        while let next = queue.first {
            if appleForReply { useServer = false }
            var data: Data?
            if useServer {
                requestAhead()
                if let pending = queue[0].audio {
                    data = try? await withTaskCancellationHandler {
                        try await pending.value
                    } onCancel: {
                        pending.cancel()
                    }
                }
                if Task.isCancelled { return }
                if data == nil {
                    // Failed: Apple reads the rest; drop what was requested ahead.
                    appleForReply = true
                    useServer = false
                    for index in queue.indices { queue[index].audio?.cancel(); queue[index].audio = nil }
                }
            }
            let item = queue.removeFirst()
            if useServer { requestAhead() } else { item.audio?.cancel() }
            // Its words start now: focus what they point at.
            if let cue = item.cue { onCue?(cue) }
            // Audio that won't play is read with an Apple voice too.
            var played = false
            if let data { played = await play(data) }
            if Task.isCancelled { return }
            if !played { await sayWithApple(next.text) }
            if Task.isCancelled { return }
        }
        queueTask = nil
        speaking = false
    }

    /// Reads one sentence with an Apple voice and returns when it ends; at
    /// once when no good voice fits.
    private func sayWithApple(_ plain: String) async {
        guard speakWithApple(plain) else { return }
        await withCheckedContinuation { utteranceDone = $0 }
    }

    private func speakWithApple(_ plain: String) -> Bool {
        guard let voice = Self.voice(for: plain) else {
            if queueTask == nil { speaking = false }
            return false
        }
        try? BlobListener.activateSession(record: false)
        // A delivery hint directs the server voice; an Apple voice would read it.
        let utterance = AVSpeechUtterance(string: CueMarkers.withoutDirections(plain))
        utterance.voice = voice
        synthesizer.stopSpeaking(at: .immediate)
        utteranceId = ObjectIdentifier(utterance)
        synthesizer.speak(utterance)
        speaking = true
        BlobMetrics.shared.audioStarted(voice: voice.quality == .premium ? "apple:premium" : "apple:enhanced")
        return true
    }

    /// Reads `plain` piece by piece with the server voice. The next piece is
    /// requested while the current one plays. On a failed request the rest
    /// falls back to an Apple voice.
    private func speakOnServer(_ plain: String) async {
        guard await refreshServerVoice()?.configured == true else {
            if !Task.isCancelled { _ = speakWithApple(plain) }
            return
        }
        let pieces = Self.pieces(plain)
        try? BlobListener.activateSession(record: false)
        var next: Task<Data, Error>? = Self.fetch(pieces.first)
        for index in pieces.indices {
            let data: Data
            do {
                guard let pending = next else { break }
                // Stopping cancels the request in flight, not only the wait.
                data = try await withTaskCancellationHandler {
                    try await pending.value
                } onCancel: {
                    pending.cancel()
                }
            } catch {
                next = nil
                if !Task.isCancelled {
                    _ = speakWithApple(pieces[index...].joined(separator: " "))
                }
                return
            }
            if Task.isCancelled { next?.cancel(); return }
            next = Self.fetch(index + 1 < pieces.count ? pieces[index + 1] : nil)
            _ = await play(data)
            if Task.isCancelled { next?.cancel(); return }
        }
        speaking = false
    }

    private static func fetch(_ piece: String?) -> Task<Data, Error>? {
        guard let piece else { return nil }
        return Task { try await OS1API.blobSpeech(piece) }
    }

    /// Plays one mp3 and returns when it ends or is stopped; false when it
    /// could not start.
    private func play(_ data: Data) async -> Bool {
        guard let player = try? AVAudioPlayer(data: data) else { return false }
        player.delegate = self
        player.isMeteringEnabled = true
        self.player = player
        var started = true
        await withCheckedContinuation { continuation in
            finished = continuation
            if player.play() {
                BlobMetrics.shared.audioStarted(voice: "fish:\(server?.model ?? "default")")
            } else {
                started = false
                endPlayback()
            }
        }
        return started
    }

    private func endPlayback() {
        player?.stop()
        player = nil
        finished?.resume()
        finished = nil
    }

    func preview(_ voice: AVSpeechSynthesisVoice) {
        stop()
        try? BlobListener.activateSession(record: false)
        let utterance = AVSpeechUtterance(string: "Hi, I\u{2019}m Blob. I\u{2019}ll be here when something needs you.")
        utterance.voice = voice
        synthesizer.stopSpeaking(at: .immediate)
        utteranceId = ObjectIdentifier(utterance)
        synthesizer.speak(utterance)
        speaking = true
    }

    func stop() {
        cutOff()
        appleForReply = false
    }

    /// Stops whatever is reading and clears the queue.
    private func cutOff() {
        serverTask?.cancel()
        serverTask = nil
        queueTask?.cancel()
        queueTask = nil
        for item in queue { item.audio?.cancel() }
        queue = []
        endPlayback()
        utteranceId = nil
        utteranceDone?.resume()
        utteranceDone = nil
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

    /// The answer in pieces for the server voice: the first sentence alone,
    /// then sentences joined up to `serverPieceChars`.
    static func pieces(_ plain: String) -> [String] {
        pieces(sentences: sentences(plain), firstAlone: true)
    }

    /// `sentences` joined up to `serverPieceChars` a piece, the first one
    /// alone when `firstAlone`.
    static func pieces(sentences: [String], firstAlone: Bool) -> [String] {
        var pieces: [String] = []
        var rest = sentences[...]
        if firstAlone, let first = rest.popFirst() { pieces.append(first) }
        var current = ""
        for sentence in rest {
            if !current.isEmpty, current.count + sentence.count + 1 > serverPieceChars {
                pieces.append(current)
                current = ""
            }
            current = current.isEmpty ? sentence : current + " " + sentence
        }
        if !current.isEmpty { pieces.append(current) }
        return pieces
    }

    private static func sentences(_ plain: String) -> [String] {
        let tokenizer = NLTokenizer(unit: .sentence)
        tokenizer.string = plain
        var sentences: [String] = []
        tokenizer.enumerateTokens(in: plain.startIndex..<plain.endIndex) { range, _ in
            let sentence = plain[range].trimmingCharacters(in: .whitespacesAndNewlines)
            if !sentence.isEmpty { sentences.append(sentence) }
            return true
        }
        return sentences
    }

    /// Markdown read aloud sounds like punctuation; speak the words only.
    static func plain(_ markdown: String) -> String {
        var s = markdown.replacingOccurrences(of: "[ \t]*" + CueMarkers.pattern, with: "", options: .regularExpression)
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
        let id = ObjectIdentifier(utterance)
        Task { @MainActor in self.utteranceEnded(id) }
    }

    nonisolated func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didCancel utterance: AVSpeechUtterance) {
        let id = ObjectIdentifier(utterance)
        Task { @MainActor in self.utteranceEnded(id) }
    }

    private func utteranceEnded(_ id: ObjectIdentifier) {
        guard id == utteranceId else { return }
        utteranceId = nil
        if let done = utteranceDone {
            utteranceDone = nil
            done.resume()
        } else {
            speaking = false
        }
    }
}

extension BlobSpeaker: AVAudioPlayerDelegate {
    nonisolated func audioPlayerDidFinishPlaying(_ player: AVAudioPlayer, successfully flag: Bool) {
        let id = ObjectIdentifier(player)
        Task { @MainActor in self.finishedPlaying(id) }
    }

    nonisolated func audioPlayerDecodeErrorDidOccur(_ player: AVAudioPlayer, error: Error?) {
        let id = ObjectIdentifier(player)
        Task { @MainActor in self.finishedPlaying(id) }
    }

    /// Only the current player ends playback; a stopped one may report late.
    private func finishedPlaying(_ id: ObjectIdentifier) {
        if let player, ObjectIdentifier(player) == id { endPlayback() }
    }
}

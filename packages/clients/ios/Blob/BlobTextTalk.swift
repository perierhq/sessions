import Foundation
import Observation

/// Talking to Blob when the server has no voice key: you speak, Apple's
/// on-device recognizer (`BlobListener`) shows what it hears, and when you
/// stop talking (or tap) Parakeet on the device (`BlobParakeet`) writes the
/// final text, else the server's Fish Audio, else Apple's own text stands.
/// The text goes to the supervisor like a typed message, and Blob shows the answer and reads its
/// first paragraph aloud (`BlobReply`, `BlobSpeaker`): with the server's Fish
/// Audio voice when it has one, else with a Premium or Enhanced Apple voice
/// when one fits.
///
/// The live voice call needs an OpenAI key on the server
/// (`GET /api/desk/voice/status` reports it). Without one, this keeps the same
/// tap-to-talk feel with nothing leaving the phone except the message itself.
@MainActor
@Observable
final class BlobTextTalk {
    enum Phase: Equatable { case idle, listening, waiting, failed(String) }

    private(set) var phase: Phase = .idle
    /// What you said, as dictation hears it.
    private(set) var heard = ""
    let listener = BlobListener()
    let speaker = BlobSpeaker()
    private var desk: SessionViewModel?
    private let owner = UUID()
    /// The last transcript entry when the message went out; the answer is
    /// what comes after it. An id, not a count, because history paging
    /// prepends older entries.
    private var sentAfter: String?
    private var connecting: Task<SessionViewModel, Error>?

    init() {
        listener.onEnd = { [weak self] decision in self?.listeningEnded(decision) }
    }

    var active: Bool { phase != .idle }
    /// Voice level for Blob's body: yours while listening, its own while it reads.
    func level(at date: Date) -> Double {
        phase == .listening ? listener.level : speaker.level(at: date)
    }
    /// The answer that was last read aloud, so it is read once.
    private var spokenAnswer: String?

    /// Blob's answer so far: streaming text while the supervisor writes, then the
    /// finished reply.
    var answer: String? {
        guard let desk, phase == .waiting else { return nil }
        if desk.isStreaming, !desk.liveText.isEmpty { return desk.liveText }
        return replyEntry?.content.flatMap { $0.isEmpty ? nil : $0 }
    }

    /// The finished reply as a transcript entry, once it has landed. Blob
    /// draws it with the block catalog (`MarkdownBody`); see adrs/blob-views.md.
    ///
    /// Anchored on the message you sent, not only on where the transcript
    /// ended: the first message after launch can go out before the
    /// transcript has loaded, and the last entry can be a streamed row whose
    /// id changes once it is saved. Either way the old anchor fell back to
    /// the whole transcript, so Blob read the previous answer, then this one.
    var replyEntry: TranscriptEntry? {
        guard let desk, phase == .waiting, !desk.isStreaming else { return nil }
        let entries = desk.entries
        let floor = sentAfter.flatMap { id in entries.lastIndex { $0.id == id } }.map { $0 + 1 } ?? 0
        guard floor < entries.count else { return nil }
        let said = heard.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let mine = entries[floor...].lastIndex(where: { entry in
            entry.type == "user" && (said.isEmpty || (entry.content ?? "").contains(said))
        }) else { return nil }
        let after = entries.index(after: mine)
        guard after < entries.count else { return nil }
        return entries[after...].last { $0.type == "assistant" && $0.isReasoning != true }
    }

    /// Earlier exchanges with the supervisor, oldest first, read from its
    /// transcript. Voice-call turns are mirrored into the same transcript.
    var history: [BlobExchange] {
        #if DEBUG
        if let demo = BlobExchange.demo { return demo }
        #endif
        return BlobExchange.exchanges(in: desk?.entries ?? [])
    }

    var canLoadEarlier: Bool { desk?.canLoadEarlier ?? false }
    var loadingEarlier: Bool { desk?.loadingEarlier ?? false }
    func loadEarlier() { desk?.loadEarlier() }

    /// Connects to the supervisor ahead of the first message so history is
    /// there to scroll back through. Only the latest page of the transcript
    /// loads; earlier pages come as you scroll.
    func connect() {
        guard desk == nil, ServerConfig.shared.isConfigured else { return }
        Task { _ = try? await supervisorModel() }
        Task { await speaker.refreshServerVoice() }
        if BlobTranscriber.current == .parakeet { BlobParakeet.shared.warm() }
    }

    /// The supervisor's quick-reply relay, so `choices` chips in a reply send.
    var relay: QuickReplyRelay? { desk?.quickReplies }

    /// True while the supervisor is still working on the answer.
    var thinking: Bool { phase == .waiting && (desk?.isRunning ?? true) && answer == nil }

    /// Tap: start listening, or send what was heard, or put Blob back to sleep.
    func tap() {
        switch phase {
        case .idle, .failed: listen()
        case .listening: send()
        case .waiting: reset()
        }
    }

    func reset() {
        listener.cancel()
        speaker.stop()
        spokenAnswer = nil
        heard = ""
        phase = .idle
    }

    /// The answer is complete: the run has finished and its reply is in.
    var settled: Bool {
        guard phase == .waiting, let desk else { return false }
        return !desk.isRunning && !desk.isStreaming && answer != nil
    }

    /// Reads the finished answer's first paragraph aloud, once; the rest is
    /// only shown (`BlobReply`). Called when `settled` turns true.
    func answerSettled() {
        guard let answer, answer != spokenAnswer else { return }
        spokenAnswer = answer
        let say = BlobReply(answer).say
        if !say.isEmpty { speaker.speak(say) }
    }

    private func listen() {
        // Blob may be reading a decision; the mic must not hear it.
        speaker.stop()
        heard = ""
        phase = .listening
        if BlobTranscriber.current == .parakeet {
            // Load while you talk; a first download only over Wi-Fi.
            BlobParakeet.shared.warm()
            BlobParakeet.shared.downloadIfFree()
        }
        Task {
            do {
                try await listener.start()
            } catch {
                phase = .failed(error.localizedDescription)
            }
        }
    }

    /// Mirrors the listener's text while listening. Called by the view.
    func syncHeard() { if phase == .listening { heard = listener.text } }

    /// The listener heard you stop, or heard nothing at all.
    private func listeningEnded(_ decision: BlobEndpointer.Decision) {
        guard phase == .listening else { return }
        switch decision {
        case .send: send()
        case .giveUp: reset()
        case .listen: break
        }
    }

    private func send() {
        phase = .waiting
        Task {
            let said = await listener.stop()
            // Tapped away meanwhile: nothing goes out.
            guard phase == .waiting else { return }
            // Apple's text first, then the better transcript in its place.
            heard = said.text.trimmingCharacters(in: .whitespacesAndNewlines)
            let text = await finalText(said)
            guard phase == .waiting else { return }
            await deliver(text)
        }
    }

    /// Longest wait for Parakeet or Fish before Apple's text goes as it is.
    static let transcribeDeadline: Double = 8

    /// Parakeet, then Fish, then Apple: the first that answers in time.
    private func finalText(_ said: BlobListener.Heard) async -> String {
        let apple = said.text.trimmingCharacters(in: .whitespacesAndNewlines)
        let choice = BlobTranscriber.current
        guard choice != .apple, said.samples.count >= Int(BlobCapture.sampleRate * 0.3) else { return apple }
        let samples = said.samples
        let language = Self.languageHint
        let fish = speaker.server?.transcribe == true
        let better = await Self.within(Self.transcribeDeadline) {
            let parakeet = BlobParakeet.shared
            if choice == .parakeet {
                while parakeet.state == .loading, !Task.isCancelled { try? await Task.sleep(for: .milliseconds(100)) }
                if let text = try? await parakeet.transcribe(samples, language: language), !text.isEmpty { return text }
            }
            if fish, let text = try? await OS1API.blobTranscribe(wav: BlobWAV.encode(samples), language: language),
               !text.isEmpty {
                return text
            }
            return nil
        }
        return better ?? apple
    }

    /// `pl` or `en` from the preferred languages; no hint for anything else.
    static var languageHint: String? {
        guard let first = Locale.preferredLanguages.first,
              let code = Locale(identifier: first).language.languageCode?.identifier,
              code == "pl" || code == "en"
        else { return nil }
        return code
    }

    /// `work`'s answer, or nil once `seconds` pass without one. Returns at
    /// the deadline even when `work` ignores cancellation.
    private static func within(_ seconds: Double, _ work: @escaping @MainActor () async -> String?) async -> String? {
        final class Once {
            var continuation: CheckedContinuation<String?, Never>?
            func resume(_ value: String?) { continuation?.resume(returning: value); continuation = nil }
        }
        let once = Once()
        return await withCheckedContinuation { continuation in
            once.continuation = continuation
            let job = Task { @MainActor in once.resume(await work()) }
            Task { @MainActor in
                try? await Task.sleep(for: .seconds(seconds))
                job.cancel()
                once.resume(nil)
            }
        }
    }

    /// A typed message, for when speaking isn't an option. Same path as speech
    /// from here on, whether or not the server has a voice key.
    func send(typed raw: String) {
        let text = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return }
        listener.cancel()
        speaker.stop()
        spokenAnswer = nil
        phase = .waiting
        Task { await deliver(text) }
    }

    private func deliver(_ text: String) async {
        heard = text
        guard !text.isEmpty else { reset(); return }
        do {
            let model = try await supervisorModel()
            sentAfter = model.entries.last?.id
            model.sendQuickReply(text)
        } catch {
            phase = .failed(error.localizedDescription)
        }
    }

    private func follow(up text: String) {
        guard let desk else { return }
        speaker.stop()
        spokenAnswer = nil
        heard = text
        phase = .waiting
        sentAfter = desk.entries.last?.id
        desk.sendQuickReply(text)
    }

    /// The supervisor session, connected once and kept for the life of the
    /// screen (adrs/supervisor-and-leads.md).
    private func supervisorModel() async throws -> SessionViewModel {
        if let desk { return desk }
        // One connection, even when the first message races `connect()`.
        if let connecting { return try await connecting.value }
        let task = Task { [owner] in
            let ensure = try await OS1API.ensureSupervisor()
            let model = SessionViewModel(session: Session(id: ensure.sessionId))
            // A chip in a reply is the next thing you say: send it and wait for
            // the answer to that, not the one already on screen.
            model.quickReplies.send = { [weak self] text in self?.follow(up: text) }
            model.start(owner: owner)
            return model
        }
        connecting = task
        do {
            let model = try await task.value
            desk = model
            connecting = nil
            return model
        } catch {
            connecting = nil
            throw error
        }
    }

    /// Whether the server can run the live voice call. Nil when it can't say
    /// (offline, older server): the caller keeps trying voice in that case.
    static func voiceConfigured() async -> Bool? {
        guard let base = ServerConfig.shared.baseURL else { return nil }
        let request = ServerConfig.shared.authorizedRequest(base.appending(path: "api/desk/voice/status"))
        struct Status: Decodable { let configured: Bool? }
        guard let (data, response) = try? await URLSession.shared.data(for: request),
              (response as? HTTPURLResponse)?.statusCode == 200,
              let status = try? JSONDecoder().decode(Status.self, from: data)
        else { return nil }
        return status.configured
    }
}

/// Who writes the final text of what you said (Settings, "Transcription").
/// Apple's recognizer draws the live captions whichever it is.
enum BlobTranscriber: String, CaseIterable {
    /// Parakeet on the device; Fish, then Apple, until it has downloaded.
    case parakeet
    /// The server's Fish Audio speech to text.
    case fish
    /// Apple's on-device text as it is.
    case apple

    static let key = "blob.transcriber"
    static var current: BlobTranscriber {
        UserDefaults.standard.string(forKey: key).flatMap(BlobTranscriber.init(rawValue:)) ?? .parakeet
    }
}

/// 16-bit PCM WAV, the plainest format Fish takes. A minute at 16 kHz is
/// under 2 MB, well inside the server's 10 MB cap.
enum BlobWAV {
    static func encode(_ samples: [Float], sampleRate: Int = Int(BlobCapture.sampleRate)) -> Data {
        var data = Data(capacity: 44 + samples.count * 2)
        func put<T: FixedWidthInteger>(_ value: T) { withUnsafeBytes(of: value.littleEndian) { data.append(contentsOf: $0) } }
        let bytes = UInt32(samples.count * 2)
        data.append(contentsOf: Array("RIFF".utf8)); put(36 + bytes)
        data.append(contentsOf: Array("WAVE".utf8))
        data.append(contentsOf: Array("fmt ".utf8)); put(UInt32(16)); put(UInt16(1)); put(UInt16(1))
        put(UInt32(sampleRate)); put(UInt32(sampleRate * 2)); put(UInt16(2)); put(UInt16(16))
        data.append(contentsOf: Array("data".utf8)); put(bytes)
        for sample in samples { put(Int16(max(-1, min(1, sample)) * Float(Int16.max))) }
        return data
    }
}

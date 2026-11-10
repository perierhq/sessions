import Foundation
import Observation

/// Talking to Blob when the server has no voice key: you speak, Apple's
/// on-device recognizer (`BlobListener`) shows what it hears, and when you
/// stop talking (or tap) the transcriber you picked in Settings writes the
/// final text (`BlobTranscriber`): Parakeet on the device (`BlobParakeet`),
/// or the server's Fish Audio, else Apple's own text stands. The recording
/// goes to Fish only when you picked Fish, or turned on Fish until Parakeet
/// is ready. The text goes to the supervisor like a typed message, and Blob
/// shows the answer and reads its first paragraph aloud (`BlobReply`,
/// `BlobSpeaker`), sentence by sentence as the reply streams in
/// (`BlobSentenceStreamer`): with the server's Fish
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
    private(set) var desk: SessionViewModel?
    private let owner = UUID()
    /// The last transcript entry when the message went out; the answer is
    /// what comes after it. An id, not a count, because history paging
    /// prepends older entries.
    private(set) var sentAfter: String?
    /// Goes up once per message sent, so a view can start a new turn exactly
    /// once however `phase`, `heard` and `sentAfter` settle around it.
    private(set) var sends = 0
    private var connecting: Task<SessionViewModel, Error>?
    /// Bumped by every listen, reset and typed message, so a transcript that
    /// finishes after you moved on is dropped instead of sent.
    private var generation = 0

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
    /// The Say sentences of the reply being written, read as each completes.
    private var sentences = BlobSentenceStreamer()
    /// Reading was cut off (Esc); the rest of this reply stays silent.
    private(set) var hushed = false

    /// A reply to your message is on its way: sent and not yet settled. It
    /// has Blob's voice; decisions are not read meanwhile.
    var replying: Bool { phase == .waiting && !settled }

    /// The reply is on its way or still being read.
    var replyHasVoice: Bool { replying || speaker.readingReply }

    /// Blob is reading, or will read the next sentence of the reply being
    /// written: steady between sentences, so Esc still hushes it.
    var reading: Bool { speaker.speaking || (replying && !hushed) }

    /// The reply text while the supervisor is still writing it; nil otherwise.
    var streamingText: String? {
        guard let desk, phase == .waiting, desk.isStreaming, !desk.liveText.isEmpty else { return nil }
        return desk.liveText
    }

    /// Reads each Say sentence as soon as it is complete, so Blob starts
    /// talking before the reply is finished. Called when `streamingText`
    /// changes.
    func answerStreamed() {
        guard !hushed, let text = streamingText else { return }
        speaker.enqueue(sentences.feed(text))
    }

    /// Blob's answer so far: streaming text while the supervisor writes, then the
    /// finished reply. Streamed text can still be a preamble: when a tool call
    /// follows, it moves into `desk.liveEntries` and this goes back to nil.
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
        let anchored = sentAfter.flatMap { id in entries.lastIndex { $0.id == id } }.map { $0 + 1 }
        let said = heard.trimmingCharacters(in: .whitespacesAndNewlines)
        // With nothing said (an answered ask) only the anchor can place the
        // reply; from the top of the transcript it would be an old answer.
        if said.isEmpty, anchored == nil { return nil }
        let floor = anchored ?? 0
        guard floor < entries.count else { return nil }
        let mine = entries[floor...].lastIndex(where: { entry in
            entry.type == "user" && (said.isEmpty || (entry.content ?? "").contains(said))
        })
        // Answering an ask adds no message of yours: the reply is whatever
        // the run writes after the answer went out.
        guard let after = mine.map({ entries.index(after: $0) }) ?? (said.isEmpty ? anchored : nil),
              after < entries.count
        else { return nil }
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

    /// What the supervisor's run is waiting on you for: a question it asked,
    /// or a force merge to confirm. Nil when nothing is pending.
    var ask: BlobAsk? {
        guard let desk else { return nil }
        if let question = desk.pendingQuestion, let ask = BlobAsk(question: question) { return ask }
        return desk.actionCards.forceMerge.map(BlobAsk.forceMerge)
    }

    /// The ask that was last read aloud, so it is read once.
    private var spokenAsk: String?

    /// Reads an ask's question aloud when it comes up, once, unless you are
    /// talking: dictating, or on the live voice call (`callActive`), whose own
    /// voice is speaking. Not counted as read then, so it is read once the
    /// call ends.
    func askCameUp(_ ask: BlobAsk, callActive: Bool) {
        guard ask.id != spokenAsk, phase != .listening, !callActive else { return }
        spokenAsk = ask.id
        let say = ask.reply.say
        if !say.isEmpty { speaker.speak(say) }
    }

    /// Why the last answer to an ask didn't go through after its card was
    /// settled (a refused merge), shown over the run's reply.
    private(set) var notice: String?

    /// Answers an ask the way the OS app does, then waits for the run's
    /// reply like any message. Throws only while the ask is still up, so its
    /// card can say why; once settled the reason shows as `notice`.
    func answer(_ ask: BlobAsk, with action: BlobAsk.Option.Action) async throws {
        guard let desk else { return }
        // The reply comes after what is on screen now. Taken before the
        // await: the run can write while the answer is on its way.
        let anchor = desk.entries.last?.id
        var failure: String?
        do {
            switch (ask, action) {
            case (.question(let question), .answer(let text)):
                guard let first = question.questions.first else { return }
                desk.answer(question: question, answers: [first.question: text])
            case (.question(let question), .skip):
                desk.answer(question: question, answers: nil)
            case (.forceMerge(let pending), .confirmMerge):
                try await desk.actionCards.confirmForceMerge(pending.request)
            case (.forceMerge(let pending), .cancelMerge):
                try await desk.actionCards.cancelForceMerge(pending.request)
            default:
                return
            }
        } catch {
            // Still pending: nothing happened, and the card shows why.
            if self.ask?.id == ask.id { throw error }
            failure = (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
        }
        speaker.stop()
        spokenAnswer = nil
        notice = failure
        // Already waiting on a message: its reply still comes after it.
        guard phase != .waiting else { return }
        listener.cancel()
        heard = ""
        sentAfter = anchor
        phase = .waiting
    }

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
        generation += 1
        listener.cancel()
        stopReading()
        notice = nil
        heard = ""
        phase = .idle
    }

    /// The answer is complete: the run has finished and its reply is in.
    var settled: Bool {
        guard phase == .waiting, let desk else { return false }
        return !desk.isRunning && !desk.isStreaming && answer != nil
    }

    /// Reads what is left of the finished answer's first paragraph: the
    /// sentences that did not stream, or were rewritten when it landed. The
    /// rest is only shown (`BlobReply`). Called when `settled` turns true.
    func answerSettled() {
        guard !hushed, let answer, answer != spokenAnswer else { return }
        spokenAnswer = answer
        speaker.enqueue(sentences.finish(answer))
    }

    /// Stops reading and forgets what was read: the next reply starts fresh.
    private func stopReading() {
        speaker.stop()
        spokenAnswer = nil
        sentences = BlobSentenceStreamer()
        hushed = false
    }

    /// Stops reading the current reply, including sentences still to stream.
    func hush() {
        speaker.stop()
        if phase == .waiting { hushed = true }
    }

    private func listen() {
        // Blob may be reading a decision; the mic must not hear it.
        stopReading()
        notice = nil
        generation += 1
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
        let listen = generation
        Task {
            let said = await listener.stop()
            guard isCurrent(listen) else { return }
            // Apple's text first, then the better transcript in its place.
            heard = said.text.trimmingCharacters(in: .whitespacesAndNewlines)
            let text = await finalText(said)
            guard isCurrent(listen) else { return }
            await deliver(text)
        }
    }

    /// Still the same listen, still waiting to send: not tapped away, not
    /// listening again or typing since.
    private func isCurrent(_ listen: Int) -> Bool { generation == listen && phase == .waiting }

    /// Longest wait for a Parakeet load already under way when you stop.
    static let parakeetLoadWait: Double = 2
    /// Longest Parakeet may take on the recording once loaded.
    static let parakeetDeadline: Double = 6
    /// Longest wait for Fish, on its own budget after Parakeet's.
    static let fishDeadline: Double = 6

    /// The transcriber you picked, then Apple: the first that answers in
    /// time. Fish hears the recording only when you picked it, or picked
    /// Parakeet with Fish until it is ready (`BlobTranscriber.fishUntilParakeetKey`).
    private func finalText(_ said: BlobListener.Heard) async -> String {
        let apple = said.text.trimmingCharacters(in: .whitespacesAndNewlines)
        let choice = BlobTranscriber.current
        guard choice != .apple, said.samples.count >= Int(BlobCapture.sampleRate * 0.3) else { return apple }
        let samples = said.samples
        if choice == .parakeet {
            let parakeet = BlobParakeet.shared
            if await parakeet.ready(within: Self.parakeetLoadWait) {
                let language = Self.languageHint
                if let text = await Self.within(Self.parakeetDeadline, {
                    try? await parakeet.transcribe(samples, language: language)
                }), !text.isEmpty {
                    return text
                }
            }
            guard BlobTranscriber.fishUntilParakeet else { return apple }
        }
        guard speaker.server?.transcribe == true else { return apple }
        // No language hint: Fish detects the language itself.
        let text = await Self.within(Self.fishDeadline) {
            let wav = await Task.detached(priority: .userInitiated) { BlobWAV.encode(samples) }.value
            return try? await OS1API.blobTranscribe(wav: wav)
        }
        return text.flatMap { $0.isEmpty ? nil : $0 } ?? apple
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
        stopReading()
        notice = nil
        generation += 1
        phase = .waiting
        Task { await deliver(text) }
    }

    private func deliver(_ text: String) async {
        heard = text
        guard !text.isEmpty else { reset(); return }
        sends += 1
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
        stopReading()
        notice = nil
        generation += 1
        heard = text
        phase = .waiting
        sentAfter = desk.entries.last?.id
        sends += 1
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
            // Blob reads the reply as it streams, whatever the account's live
            // typing preference; the model's thinking stays out of it.
            model.streamsLiveText = true
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
    /// Parakeet on the device; until it is ready, Apple's text, or Fish when
    /// `fishUntilParakeet` is on.
    case parakeet
    /// The server's Fish Audio speech to text.
    case fish
    /// Apple's on-device text as it is.
    case apple

    static let key = "blob.transcriber"
    static var current: BlobTranscriber {
        UserDefaults.standard.string(forKey: key).flatMap(BlobTranscriber.init(rawValue:)) ?? .parakeet
    }

    /// Opt-in, off by default: with Parakeet picked, send the recording to
    /// Fish while Parakeet isn't downloaded or loaded.
    static let fishUntilParakeetKey = "blob.fishUntilParakeet"
    static var fishUntilParakeet: Bool { UserDefaults.standard.bool(forKey: fishUntilParakeetKey) }
}

/// 16-bit PCM WAV, the plainest format Fish takes. A minute at 16 kHz is
/// under 2 MB, well inside the server's 10 MB cap.
/// Pure work on a copy of the samples; run it off the main actor.
enum BlobWAV {
    nonisolated static func encode(_ samples: [Float], sampleRate: Int = Int(BlobCapture.sampleRate)) -> Data {
        let pcm = samples.map { Int16(max(-1, min(1, $0)) * Float(Int16.max)).littleEndian }
        var data = Data(capacity: 44 + pcm.count * 2)
        func put<T: FixedWidthInteger>(_ value: T) { withUnsafeBytes(of: value.littleEndian) { data.append(contentsOf: $0) } }
        let bytes = UInt32(pcm.count * 2)
        data.append(contentsOf: Array("RIFF".utf8)); put(36 + bytes)
        data.append(contentsOf: Array("WAVE".utf8))
        data.append(contentsOf: Array("fmt ".utf8)); put(UInt32(16)); put(UInt16(1)); put(UInt16(1))
        put(UInt32(sampleRate)); put(UInt32(sampleRate * 2)); put(UInt16(2)); put(UInt16(16))
        data.append(contentsOf: Array("data".utf8)); put(bytes)
        pcm.withUnsafeBytes { data.append(contentsOf: $0) }
        return data
    }
}

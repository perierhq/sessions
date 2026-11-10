import Foundation
import Observation
import os

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
    /// Bumped only by what you do (a listen, a tap that resets, a typed
    /// message), so a transcript that finishes after you moved on is dropped
    /// instead of sent. Nothing else may drop what you said.
    private var generation = 0
    /// The outbox id of the message on its way. The server's user entry for
    /// it carries the same id, so the reply is anchored on that entry and
    /// not on whatever the supervisor happens to be writing.
    private(set) var sentId: String?
    /// What the supervisor was already streaming when the server took your
    /// message: another turn's text (a wake, a worker report), never the
    /// answer. Nil until the server's copy of the message is seen.
    private var foreignText: String?
    /// Tool calls already under way at that point, by `toolUseId ?? id`.
    private var foreignIds: Set<String> = []
    /// Waiting on the run's reply to an answered ask, which adds no message.
    private var answeringAsk = false
    /// A message that couldn't be sent; a tap sends it again.
    private var unsent: String?
    /// When the message went to the outbox, for the log.
    @ObservationIgnored private var sentAt: ContinuousClock.Instant?
    /// The reply was logged as anchored for this message.
    @ObservationIgnored private var anchoredLogged = false
    /// How the last listen ended and who wrote its text, for `BlobMetrics`.
    @ObservationIgnored private var endOfSpeech = BlobMetrics.EndOfSpeech.tap
    @ObservationIgnored private var transcribedBy = BlobMetrics.Transcriber.apple

    /// Each step of a turn, with ids, lengths and times only: never what was said.
    static let log = Logger(subsystem: "pl.sessions.blob", category: "talk")

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

    /// The reply text while the supervisor is still writing it; nil otherwise,
    /// and nil while what streams belongs to another turn (`ownsStream`).
    var streamingText: String? {
        guard let desk, phase == .waiting, desk.isStreaming, !desk.liveText.isEmpty, ownsStream else { return nil }
        return desk.liveText
    }

    /// Whether the supervisor's live text answers your message. It writes
    /// for its own reasons too (a `wait_for` wake, a worker report), and a
    /// message sent mid-run lands in that run at its next tool boundary. So
    /// the stream counts only once the server's copy of your message is in,
    /// no later message came after it, and the text is not the block that
    /// was already streaming when it landed.
    private var ownsStream: Bool {
        guard let desk else { return false }
        if answeringAsk { return true }
        let entries = desk.entries
        guard let foreignText, let at = acceptedIndex(in: entries),
              !entries[entries.index(after: at)...].contains(where: \.isUser)
        else { return false }
        return foreignText.isEmpty || !desk.liveText.hasPrefix(foreignText)
    }

    /// Reads each Say sentence as soon as it is complete, so Blob starts
    /// talking before the reply is finished. Called when `streamingText`
    /// changes.
    func answerStreamed() {
        guard let text = streamingText else { return }
        logAnchored(streaming: true)
        BlobMetrics.shared.firstToken()
        guard !hushed else { return }
        let next = sentences.feed(text)
        BlobMetrics.shared.willSpeak(next.count)
        speaker.enqueue(next)
    }

    /// Blob's answer so far: streaming text while the supervisor writes, then the
    /// finished reply. Streamed text can still be a preamble: when a tool call
    /// follows, it moves into `desk.liveEntries` and this goes back to nil.
    var answer: String? {
        guard phase == .waiting else { return nil }
        if let streamingText { return streamingText }
        return replyEntry?.content.flatMap { $0.isEmpty ? nil : $0 }
    }

    /// The server's copy of the message on its way: the user entry carrying
    /// its outbox id, as its own row or one source of a batched turn. The
    /// local echo doesn't count; it is there before the server has anything.
    var acceptedEntry: TranscriptEntry? {
        guard let desk else { return nil }
        return acceptedIndex(in: desk.entries).map { desk.entries[$0] }
    }

    private func acceptedIndex(in entries: [TranscriptEntry]) -> Int? {
        guard phase == .waiting, !answeringAsk, let sentId else { return nil }
        return entries.lastIndex { entry in
            entry.isUser && (entry.id == sentId || (entry.sourceMessageIds ?? []).contains(sentId))
        }
    }

    /// The server has your message: notes what was already streaming then,
    /// so it is never taken for the answer. Called when `acceptedEntry` changes.
    func accepted() {
        guard let desk, foreignText == nil, let entry = acceptedEntry else { return }
        BlobMetrics.shared.accepted()
        foreignText = desk.liveText
        foreignIds = Set(desk.liveEntries.map { $0.toolUseId ?? $0.id })
        let ms = sentAt.map { Self.ms(since: $0) } ?? -1
        Self.log.info("server ack entry=\(entry.id, privacy: .public) ms=\(ms, privacy: .public) running=\(desk.isRunning, privacy: .public) foreignChars=\(desk.liveText.count, privacy: .public) foreignTools=\(self.foreignIds.count, privacy: .public)")
    }

    private func logAnchored(streaming: Bool) {
        guard !anchoredLogged else { return }
        anchoredLogged = true
        let ms = sentAt.map { Self.ms(since: $0) } ?? -1
        Self.log.info("reply anchored streaming=\(streaming, privacy: .public) ms=\(ms, privacy: .public) sent=\(self.sentId ?? "-", privacy: .public)")
    }

    static func ms(since start: ContinuousClock.Instant) -> Int {
        let elapsed = ContinuousClock.now - start
        return Int(elapsed.components.seconds * 1000 + elapsed.components.attoseconds / 1_000_000_000_000_000)
    }

    /// The finished reply as a transcript entry, once it has landed. Blob
    /// draws it with the block catalog (`MarkdownBody`); see adrs/blob-views.md.
    ///
    /// Anchored on the message you sent, not only on where the transcript
    /// ended: the first message after launch can go out before the
    /// transcript has loaded, and the last entry can be a streamed row whose
    /// id changes once it is saved. Either way the old anchor fell back to
    /// the whole transcript, so Blob read the previous answer, then this one.
    ///
    /// A message is anchored on the server's user entry for it
    /// (`acceptedEntry`), which arrives mid-run when it steered a busy run:
    /// the reply is the last assistant text after it, in the same run or the
    /// next. The block that was already streaming when it landed belongs to
    /// that run's own work and is skipped.
    var replyEntry: TranscriptEntry? {
        guard let desk, phase == .waiting, !desk.isStreaming else { return nil }
        let entries = desk.entries
        guard let start = turnStart(in: entries), start < entries.count else { return nil }
        let foreign = foreignText?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return entries[start...].last { entry in
            entry.type == "assistant" && entry.isReasoning != true
                && (foreign.isEmpty || !entry.text.hasPrefix(foreign))
        }
    }

    /// Where this turn's entries start: just after the server's copy of your
    /// message. Answering an ask adds no message of yours, so then it is
    /// after the last user entry since the answer went out, or right after
    /// where the transcript ended. Nil until known: from the top of the
    /// transcript it would be an old answer.
    private func turnStart(in entries: [TranscriptEntry]) -> Int? {
        guard answeringAsk else { return acceptedIndex(in: entries).map { $0 + 1 } }
        guard let anchor = sentAfter.flatMap({ id in entries.lastIndex { $0.id == id } }) else { return nil }
        let floor = anchor + 1
        guard floor <= entries.count else { return nil }
        return entries[floor...].lastIndex(where: \.isUser).map { $0 + 1 } ?? floor
    }

    /// The supervisor's entries after the message you sent, durable then
    /// streamed, without the tool calls another turn already had under way.
    /// Empty until the server's copy of the message lands.
    var turnEntries: [TranscriptEntry] {
        guard let desk, phase == .waiting else { return [] }
        let entries = desk.entries
        guard let start = turnStart(in: entries), start <= entries.count else { return [] }
        let foreign = foreignIds
        let durable = entries[start...].filter { !foreign.contains($0.toolUseId ?? $0.id) }
        // Before the snapshot (`accepted`) live entries can't be told apart.
        guard answeringAsk || foreignText != nil else { return durable }
        let landed = Set(durable.map(BlobThinkingTurn.key))
        return durable + desk.liveEntries.filter {
            !landed.contains(BlobThinkingTurn.key($0)) && !foreign.contains($0.toolUseId ?? $0.id)
        }
    }

    /// Earlier exchanges with the supervisor, oldest first, read from its
    /// transcript. Voice-call turns are mirrored into the same transcript.
    var history: [BlobExchange] {
        #if DEBUG
        if let demo = BlobExchange.demo { return demo }
        #endif
        return BlobExchange.exchanges(in: desk?.entries ?? [])
    }

    /// The exchanges above the current one on Blob's page: everything before
    /// the message on screen, which is drawn below them as the current
    /// exchange. All of history when no message is on its way.
    var earlier: [BlobExchange] {
        #if DEBUG
        if let demo = BlobExchange.demo { return demo }
        #endif
        let entries = desk?.entries ?? []
        let cut: Int? = answeringAsk
            ? sentAfter.flatMap { id in entries.lastIndex { $0.id == id } }.map { $0 + 1 }
            : acceptedIndex(in: entries)
        guard let cut else { return BlobExchange.exchanges(in: entries) }
        return BlobExchange.exchanges(in: Array(entries[..<cut]))
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
        BlobMetrics.shared.flush()
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
        startTurn(answeringAsk: true)
        BlobMetrics.shared.began(.ask, inputChars: 0)
        phase = .waiting
    }

    /// True while the supervisor is still working on the answer, and while
    /// your message is on its way: until the server has it, a run that is
    /// not yet running (or one busy with its own work) says nothing about it.
    var thinking: Bool {
        guard phase == .waiting, answer == nil else { return false }
        guard let desk else { return true }
        return desk.isRunning || (!answeringAsk && acceptedEntry == nil)
    }

    /// Tap: start listening, or send what was heard, or put Blob back to
    /// sleep. After a failed send it sends the same text again.
    func tap() {
        switch phase {
        case .idle, .failed:
            if let unsent { send(typed: unsent) } else { listen() }
        case .listening:
            Self.log.info("endpoint decision=tap")
            endOfSpeech = .tap
            send()
        case .waiting: reset()
        }
    }

    func reset() {
        generation += 1
        listener.cancel()
        BlobMetrics.shared.stopping(speaking: replyHasVoice)
        BlobMetrics.shared.close()
        stopReading()
        notice = nil
        unsent = nil
        heard = ""
        phase = .idle
    }

    /// The app went to the background: the mic closes and reading stops. A
    /// message already captured still goes (the outbox keeps it on disk
    /// until the server has it), and a failed one stays to be tapped again.
    func pause() {
        if phase == .listening { reset() } else { stopReading() }
    }

    /// Forgets the last turn's anchor before a new one.
    private func startTurn(answeringAsk: Bool) {
        self.answeringAsk = answeringAsk
        sentId = nil
        foreignText = nil
        foreignIds = []
        anchoredLogged = false
        sentAt = nil
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
        guard let answer else { return }
        logAnchored(streaming: false)
        BlobMetrics.shared.settled(answer: answer, replyEntryId: replyEntry?.id, turnEntries: turnEntries)
        if answer != spokenAnswer {
            let ms = sentAt.map { Self.ms(since: $0) } ?? -1
            Self.log.info("settled chars=\(answer.count, privacy: .public) ms=\(ms, privacy: .public)")
        }
        guard !hushed, answer != spokenAnswer else { return }
        spokenAnswer = answer
        let rest = sentences.finish(answer)
        BlobMetrics.shared.willSpeak(rest.count)
        speaker.enqueue(rest)
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
        BlobMetrics.shared.stopping(speaking: replyHasVoice, by: .hush)
        speaker.stop()
        if phase == .waiting { hushed = true }
    }

    private func listen() {
        // Blob may be reading a decision; the mic must not hear it.
        BlobMetrics.shared.stopping(speaking: replyHasVoice)
        stopReading()
        notice = nil
        unsent = nil
        generation += 1
        heard = ""
        phase = .listening
        BlobMetrics.shared.listeningStarted()
        Self.log.info("listen start transcriber=\(BlobTranscriber.current.rawValue, privacy: .public) parakeet=\(String(describing: BlobParakeet.shared.state), privacy: .public)")
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
        Self.log.info("endpoint decision=\(String(describing: decision), privacy: .public)")
        switch decision {
        case .send:
            endOfSpeech = .auto
            send()
        case .giveUp: reset()
        case .listen: break
        }
    }

    private func send() {
        phase = .waiting
        startTurn(answeringAsk: false)
        BlobMetrics.shared.speechEnded()
        let listen = generation
        Task {
            let started = ContinuousClock.now
            let said = await listener.stop(within: Self.stopDeadline)
            Self.log.info("stop done ms=\(Self.ms(since: started), privacy: .public) finished=\(said.finished, privacy: .public) chars=\(said.text.count, privacy: .public) samples=\(said.samples.count, privacy: .public)")
            guard isCurrent(listen) else { return }
            // Apple's text first, then the better transcript in its place.
            heard = said.text.trimmingCharacters(in: .whitespacesAndNewlines)
            let text = await finalText(said)
            guard isCurrent(listen) else { return }
            if !text.isEmpty {
                BlobMetrics.shared.began(
                    .voice, inputChars: text.count, transcriber: transcribedBy,
                    transcribeMs: Self.ms(since: started), endOfSpeech: endOfSpeech
                )
            }
            await deliver(text)
        }
    }

    /// Still the same listen: you haven't tapped it away, listened again or
    /// typed since. Only what you do moves `generation`; the phase is not
    /// checked, so nothing else can drop what you said.
    private func isCurrent(_ listen: Int) -> Bool {
        guard generation == listen else {
            Self.log.info("dropped: moved on by you")
            return false
        }
        return true
    }

    /// Longest wait for Apple's model to finish its last phrase when you
    /// stop; past it, the text it had shown goes.
    static let stopDeadline: Double = 2

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
        let started = ContinuousClock.now
        func used(_ source: String, _ text: String) -> String {
            transcribedBy = BlobMetrics.Transcriber(rawValue: String(source.prefix { $0 != " " })) ?? .apple
            Self.log.info("transcriber used=\(source, privacy: .public) ms=\(Self.ms(since: started), privacy: .public) chars=\(text.count, privacy: .public)")
            return text
        }
        let apple = said.text.trimmingCharacters(in: .whitespacesAndNewlines)
        let choice = BlobTranscriber.current
        guard choice != .apple, said.samples.count >= Int(BlobCapture.sampleRate * 0.3) else { return used("apple", apple) }
        let samples = said.samples
        if choice == .parakeet {
            let parakeet = BlobParakeet.shared
            if await parakeet.ready(within: Self.parakeetLoadWait) {
                let language = Self.languageHint
                if let text = await Self.within(Self.parakeetDeadline, {
                    try? await parakeet.transcribe(samples, language: language)
                }), !text.isEmpty {
                    return used("parakeet", text)
                }
            }
            guard BlobTranscriber.fishUntilParakeet else {
                return used("apple (parakeet \(String(describing: parakeet.state)))", apple)
            }
        }
        guard speaker.server?.transcribe == true else { return used("apple", apple) }
        // No language hint: Fish detects the language itself.
        let text = await Self.within(Self.fishDeadline) {
            let wav = await Task.detached(priority: .userInitiated) { BlobWAV.encode(samples) }.value
            return try? await OS1API.blobTranscribe(wav: wav)
        }
        if let text, !text.isEmpty { return used("fish", text) }
        return used("apple (fish missed)", apple)
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
    func send(typed raw: String, as input: BlobMetrics.Input = .typed) {
        let text = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return }
        listener.cancel()
        BlobMetrics.shared.stopping(speaking: replyHasVoice)
        BlobMetrics.shared.began(input, inputChars: text.count)
        stopReading()
        notice = nil
        unsent = nil
        generation += 1
        phase = .waiting
        startTurn(answeringAsk: false)
        Task { await deliver(text) }
    }

    /// Hands the message to the outbox, which keeps it on disk until the
    /// server has it. It steers: a run already going (a `wait_for` wake, a
    /// worker report) takes it at its next tool boundary and answers it
    /// without its own work being stopped, and with no run it starts one.
    /// The composer's "queue" would park it until every worker under the
    /// supervisor finished. If it can't be handed over, it stays on screen
    /// with a notice, and a tap sends it again.
    private func deliver(_ text: String) async {
        heard = text
        guard !text.isEmpty else {
            Self.log.info("nothing heard")
            reset()
            return
        }
        let listen = generation
        sends += 1
        let model: SessionViewModel
        do {
            model = try await supervisorModel()
        } catch {
            couldNotSend(text, error.localizedDescription)
            return
        }
        guard isCurrent(listen) else { return }
        sentAfter = model.entries.last?.id
        guard let id = model.sendSteer(text) else {
            couldNotSend(text, "The outbox is full.")
            return
        }
        sentId = id
        sentAt = ContinuousClock.now
        Self.log.info("deliver enqueued outbox=\(id, privacy: .public) chars=\(text.count, privacy: .public) running=\(model.isRunning, privacy: .public)")
    }

    private func couldNotSend(_ text: String, _ reason: String) {
        Self.log.error("deliver failed chars=\(text.count, privacy: .public) reason=\(reason, privacy: .public)")
        BlobMetrics.shared.failed()
        unsent = text
        heard = text
        notice = "Couldn\u{2019}t send. Tap to try again."
        phase = .failed(reason)
    }

    private func follow(up text: String) { send(typed: text, as: .chip) }

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

import Foundation
import Observation
import os
#if os(iOS)
import UIKit
#endif

/// Talking to Blob when the server has no voice key: you speak, Apple's
/// on-device recognizer (`BlobListener`) shows what it hears, and when you
/// stop talking (or tap) the transcriber you picked in Settings writes the
/// final text (`BlobTranscriber`): Parakeet on the device (`BlobParakeet`),
/// or the server's Fish Audio, else Apple's own text stands. The recording
/// goes to Fish only when you picked Fish, or turned on Fish until Parakeet
/// is ready. The text goes to the supervisor like a typed message, and Blob
/// shows the answer and reads its spoken script aloud (`BlobReply`,
/// `BlobSpeaker`), segment by segment as the reply streams in
/// (`BlobSentenceStreamer`), focusing what each cue points at (`focus`):
/// with the server's Fish
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
    /// The listen whose recording waits for Parakeet to finish loading.
    private var earsFor: Int?
    /// You have stopped and the recording waits for Parakeet to load: the
    /// captions say Blob is getting its ears ready.
    var waitingForEars: Bool { phase == .waiting && earsFor == generation }
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
    /// How the last listen ended, for `BlobMetrics`.
    @ObservationIgnored private var endOfSpeech = BlobMetrics.EndOfSpeech.tap
    /// The listen whose text is still being written: from your stop until
    /// it is handed to the outbox or dropped. A tap then sends it sooner,
    /// never drops it.
    private var transcribing: Int?
    /// The listen you asked to go now (a tap, the app leaving the screen):
    /// it skips the Parakeet and Fish waits and takes Apple's text unless
    /// Parakeet is already loaded.
    private var hurried: Int?
    /// The last listen recorded as dropped, so it is counted once.
    @ObservationIgnored private var droppedListen: Int?
    /// The voice turn on its way to the outbox: from your stop until its
    /// text is handed over or dropped. Unlike `transcribing` it lasts
    /// through `deliver`.
    @ObservationIgnored private var voiceInFlight: Int?
    /// The voice turn whose background time ran out: its text is kept as
    /// `unsent`, so its own task must not hand it to the outbox as well.
    @ObservationIgnored private var expiredListen: Int?
    #if os(iOS)
    /// Background time asked for so a voice turn reaches the outbox after
    /// the app leaves the screen, and the listen it is for.
    @ObservationIgnored private var backgroundTask: UIBackgroundTaskIdentifier = .invalid
    @ObservationIgnored private var backgroundListen: Int?
    #endif

    /// Each step of a turn, with ids, lengths and times only: never what was said.
    static let log = BlobLog(category: "talk")

    init() {
        listener.onEnd = { [weak self] decision in self?.listeningEnded(decision) }
        speaker.onCue = { [weak self] id in self?.cueStarted(id) }
        speaker.onQueueDrained = { [weak self] in self?.queueDrained() }
    }

    /// The shown element the words being spoken point at (`BlobCues`): set
    /// when a segment with a cue starts playing, kept through segments
    /// without one, cleared once the reply has been read or with the reply.
    /// `tick` is new on every cue, never reused, so the same element pulses
    /// again when pointed at again, and only then (`CuePulses`).
    struct Focus: Equatable {
        var id: String
        var tick: Int
    }

    private(set) var focus: Focus?
    private var cueTicks = 0

    private func cueStarted(_ id: String) {
        cueTicks += 1
        focus = Focus(id: id, tick: cueTicks)
    }

    /// Reading caught up. Once the reply has settled there is nothing left
    /// to say, so nothing is pointed at; mid-stream the next segment may
    /// still keep the focus.
    private func queueDrained() {
        if !replying { focus = nil }
    }

    var active: Bool { phase != .idle }
    /// Voice level for Blob's body: yours while listening, its own while it reads.
    func level(at date: Date) -> Double {
        phase == .listening ? listener.level : speaker.level(at: date)
    }
    /// The answer that was last read aloud, so it is read once.
    private var spokenAnswer: String?
    /// The Say segments of the reply being written, read as each completes.
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
        Self.log.info("server ack entry=\(entry.id) ms=\(ms) running=\(desk.isRunning) foreignChars=\(desk.liveText.count) foreignTools=\(self.foreignIds.count)")
    }

    private func logAnchored(streaming: Bool) {
        guard !anchoredLogged else { return }
        anchoredLogged = true
        let ms = sentAt.map { Self.ms(since: $0) } ?? -1
        Self.log.info("reply anchored streaming=\(streaming) ms=\(ms) sent=\(self.sentId ?? "-")")
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
        return BlobExchange.exchanges(in: desk?.entries ?? [], shownBeside: shownBeside)
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
        guard let cut else { return BlobExchange.exchanges(in: entries, shownBeside: shownBeside) }
        return BlobExchange.exchanges(in: Array(entries[..<cut]), shownBeside: shownBeside)
    }

    /// The message that starts the exchange on screen: the server's copy of
    /// the one you sent, or, answering an ask, the last one before it.
    var currentExchangeId: String? {
        guard let desk, let start = turnStart(in: desk.entries) else { return nil }
        let entries = desk.entries[..<min(start, desk.entries.count)]
        return entries.last { $0.isUser && $0.notice == nil }?.id
    }

    /// Messages whose exchange was shown across two panes, newest last, so
    /// history lays them out that way again (`BlobExchange.split`). Kept
    /// across launches; only the latest few hundred.
    private(set) var shownBeside: Set<String> = Set(UserDefaults.standard.stringArray(forKey: shownBesideKey) ?? [])
    private static let shownBesideKey = "blob.shownBeside"

    func markShownBeside(_ id: String) {
        guard !shownBeside.contains(id) else { return }
        shownBeside.insert(id)
        var kept = UserDefaults.standard.stringArray(forKey: Self.shownBesideKey) ?? []
        kept.append(id)
        UserDefaults.standard.set(Array(kept.suffix(300)), forKey: Self.shownBesideKey)
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
        let say = ask.reply.spoken
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
    /// sleep. After a failed send it sends the same text again. Until the
    /// server has your message a tap never puts Blob to sleep: while the
    /// text is still being written it goes now, with Apple's text if
    /// Parakeet isn't loaded, and once it is in the outbox the tap waits
    /// with it.
    func tap() {
        switch phase {
        case .idle, .failed:
            if let unsent { send(typed: unsent) } else { listen() }
        case .listening:
            Self.log.info("endpoint decision=tap")
            endOfSpeech = .tap
            send()
        case .waiting:
            if transcribing == generation {
                hurry()
            } else if !answeringAsk, acceptedEntry == nil {
                Self.log.info("tap waiting: on its way outbox=\(sentId ?? "-")")
            } else if let unsent {
                // An earlier message that didn't go out (`keepEarlier`).
                send(typed: unsent)
            } else {
                reset()
            }
        }
    }

    /// Lets the exchange on screen go (history, a Bark link) without
    /// dropping what you said: a voice turn still being written goes now,
    /// a listen goes on, and a message that couldn't be sent stays to be
    /// tapped again. A message already in the outbox goes whatever happens
    /// here.
    func letGo() {
        switch phase {
        case .listening: return
        case .failed where unsent != nil: return
        case .waiting where transcribing == generation: hurry()
        default:
            let kept = unsent
            let shown = notice
            reset()
            // An earlier message that didn't go out stays to be tapped.
            if let kept { keepUnsent(kept, reason: "Not sent.", notice: shown ?? Self.earlierNotice) }
        }
    }

    /// Skips the waits for the text being written now (`hurried`), and
    /// keeps the app running until it is in the outbox.
    private func hurry() {
        if voiceInFlight == generation { beginBackgroundSend(generation) }
        guard hurried != generation else { return }
        hurried = generation
        Self.log.info("hurry parakeet=\(BlobParakeet.shared.state.wireName) ears=\(earsFor == generation)")
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
    /// Words heard so far go now, without waiting for Parakeet to load;
    /// with none heard the listen ends, and says so when you come back.
    /// What you said that is still being written goes now too, with
    /// Apple's text if Parakeet isn't loaded, instead of waiting while
    /// the app is suspended.
    func pause() {
        guard phase == .listening else {
            if phase == .waiting, voiceInFlight == generation {
                if transcribing == generation { hurry() } else { beginBackgroundSend(generation) }
            }
            stopReading()
            return
        }
        let words = listener.text.trimmingCharacters(in: .whitespacesAndNewlines)
        Self.log.info("pause listening chars=\(words.count)")
        if words.isEmpty {
            dropVoice(.backgrounded, final: nil, listen: generation)
        } else {
            endOfSpeech = .auto
            send(hurried: true)
        }
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

    /// Reads what is left of the finished answer's spoken script: the
    /// segments that did not stream, or were rewritten when it landed. The
    /// rest is only shown (`BlobReply`). Called when `settled` turns true.
    func answerSettled() {
        guard let answer else { return }
        logAnchored(streaming: false)
        BlobMetrics.shared.settled(answer: answer, replyEntryId: replyEntry?.id, turnEntries: turnEntries)
        if answer != spokenAnswer {
            let ms = sentAt.map { Self.ms(since: $0) } ?? -1
            Self.log.info("settled chars=\(answer.count) ms=\(ms)")
        }
        guard !hushed, answer != spokenAnswer else { return }
        spokenAnswer = answer
        let rest = sentences.finish(answer)
        BlobMetrics.shared.willSpeak(rest.count)
        speaker.enqueue(rest)
        // Read to the end already, while it streamed.
        if !speaker.readingReply { focus = nil }
    }

    /// Stops reading and forgets what was read: the next reply starts fresh.
    private func stopReading() {
        speaker.stop()
        spokenAnswer = nil
        focus = nil
        CuePulses.reset()
        sentences = BlobSentenceStreamer()
        hushed = false
    }

    /// Stops reading the current reply, including sentences still to stream.
    func hush() {
        BlobMetrics.shared.stopping(speaking: replyHasVoice, by: .hush)
        speaker.stop()
        focus = nil
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
        Self.log.info("listen start transcriber=\(BlobTranscriber.current.rawValue) parakeet=\(String(describing: BlobParakeet.shared.state))")
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
        Self.log.info("endpoint decision=\(String(describing: decision))")
        switch decision {
        case .send:
            endOfSpeech = .auto
            send()
        case .giveUp:
            endOfSpeech = .auto
            // Apple wrote words the VAD or the level didn't count as
            // speech: they are what you said, so they go.
            if listener.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                dropVoice(.nothingHeard, final: nil, listen: generation)
            } else {
                send()
            }
        case .listen: break
        }
    }

    private func send(hurried hurry: Bool = false) {
        phase = .waiting
        startTurn(answeringAsk: false)
        BlobMetrics.shared.speechEnded()
        let listen = generation
        transcribing = listen
        voiceInFlight = listen
        if hurry {
            hurried = listen
            beginBackgroundSend(listen)
        }
        let atCap = listener.endedAtCap
        Task {
            defer {
                if voiceInFlight == listen { voiceInFlight = nil }
                endBackgroundSend(listen)
            }
            let started = ContinuousClock.now
            let said = await listener.stop(within: Self.stopDeadline)
            Self.log.info("stop done ms=\(Self.ms(since: started)) finished=\(said.finished) chars=\(said.text.count) samples=\(said.samples.count) stillText=\(self.listener.endedByStillText) atCap=\(atCap)")
            guard isCurrent(listen) else {
                dropVoice(.movedOn, final: nil, listen: listen)
                return
            }
            // Apple's text first, then the better transcript in its place.
            heard = said.text.trimmingCharacters(in: .whitespacesAndNewlines)
            guard let final = await finalText(said, stopMs: Self.ms(since: started), listen: listen),
                  isCurrent(listen)
            else {
                dropVoice(.movedOn, final: nil, listen: listen)
                return
            }
            guard !final.text.isEmpty else {
                dropVoice(atCap ? .noEndpoint : .nothingHeard, final: final, listen: listen)
                return
            }
            // Misheard names put right ("Butter Band" to BetterBahn), whoever
            // wrote the text. Only the count is logged and measured.
            let corrected = BlobGlossary.correct(final.text, glossary: BlobGlossary.terms)
            let text = corrected.text
            if corrected.fixes > 0 { Self.log.info("glossary fixes=\(corrected.fixes)") }
            BlobMetrics.shared.began(
                .voice, inputChars: text.count, transcriber: final.transcriber,
                transcribeMs: final.ms, transcriberReason: final.reason,
                parakeetMiss: final.parakeetMiss, parakeetLoadMs: final.parakeetLoadMs,
                parakeetWaitMs: final.parakeetWaitMs, parakeetLoad: final.parakeetLoad,
                glossaryFixes: corrected.fixes, endOfSpeech: endOfSpeech
            )
            if transcribing == listen { transcribing = nil }
            await deliver(text)
        }
    }

    /// A voice turn that won't go out: never silently. Recorded as an
    /// abandoned turn with why (`BlobMetrics.dropped`) and logged; unless
    /// you moved on to something else you sent, Blob goes back to sleep
    /// and says it didn't catch it, or that its ears aren't ready yet.
    private func dropVoice(_ why: BlobMetrics.Dropped, final: Final?, listen: Int) {
        if transcribing == listen { transcribing = nil }
        // Once per listen: typing over it drops it before its own task sees.
        guard droppedListen != listen else { return }
        droppedListen = listen
        let parakeet = BlobParakeet.shared.state
        let earsNotReady = listener.preparing
            || (BlobTranscriber.current == .parakeet && parakeet == .loading)
            || final?.reason == .parakeetSkipped
            || final?.reason == .parakeetLoadingTimeout
        Self.log.info("dropped why=\(why.rawValue) heardChars=\(heard.count) transcriber=\(final?.transcriber.rawValue ?? "-") reason=\(final?.reason.rawValue ?? "-") parakeet=\(parakeet.wireName) waitMs=\(final?.parakeetWaitMs ?? -1) ears=\(earsNotReady)")
        BlobMetrics.shared.dropped(
            why, final: final, heardChars: heard.count, speechMs: BlobMetrics.shared.speechMs,
            parakeetWaitMs: final?.parakeetWaitMs, endOfSpeech: why == .backgrounded ? nil : endOfSpeech,
            parakeetState: parakeet
        )
        // What you sent instead is on screen now.
        guard why != .movedOn else { return }
        reset()
        let notice = earsNotReady ? Self.earsNotice : Self.missedNotice
        self.notice = notice
        let shown = generation
        Task {
            try? await Task.sleep(for: .seconds(Self.dropNoticeSeconds))
            if generation == shown, self.notice == notice { self.notice = nil }
        }
    }

    static let missedNotice = "I didn\u{2019}t catch that."
    static let earsNotice = "Still getting my ears ready. Say it again in a moment."
    static let backgroundNotice = "Not sent: Blob was closed before it went out. Tap to send it."
    static let earlierNotice = "An earlier message didn\u{2019}t send. Tap to send it."

    /// Asks for background time for `listen`'s trip to the outbox. Ended
    /// by its send task on every way out (`endBackgroundSend`); if the time
    /// runs out first, what was heard is kept to be sent by a tap.
    private func beginBackgroundSend(_ listen: Int) {
        #if os(iOS)
        guard backgroundListen != listen else { return }
        endBackgroundSend(backgroundListen)
        backgroundListen = listen
        backgroundTask = UIApplication.shared.beginBackgroundTask(withName: "blob-voice-send") { [weak self] in
            MainActor.assumeIsolated { self?.backgroundExpired(listen) }
        }
        Self.log.info("background send start listen=\(listen) granted=\(self.backgroundTask != .invalid)")
        #endif
    }

    private func endBackgroundSend(_ listen: Int?) {
        #if os(iOS)
        guard let listen, backgroundListen == listen else { return }
        backgroundListen = nil
        let task = backgroundTask
        backgroundTask = .invalid
        if task != .invalid { UIApplication.shared.endBackgroundTask(task) }
        #endif
    }

    /// The background time ran out before `listen` reached the outbox:
    /// what was heard stays as `unsent`, with a notice for when you come
    /// back, and its task stops before the outbox.
    private func backgroundExpired(_ listen: Int) {
        endBackgroundSend(listen)
        guard voiceInFlight == listen, isCurrent(listen) else { return }
        let text = heard.trimmingCharacters(in: .whitespacesAndNewlines)
        Self.log.error("background send expired listen=\(listen) chars=\(text.count) transcribing=\(self.transcribing == listen)")
        guard !text.isEmpty else {
            dropVoice(.backgrounded, final: nil, listen: listen)
            return
        }
        let began = transcribing != listen
        expiredListen = listen
        // Kept, not dropped: its own task must not count it as moved on.
        droppedListen = listen
        voiceInFlight = nil
        transcribing = nil
        earsFor = nil
        listener.cancel()
        generation += 1
        if began {
            // `deliver` had started: the open metric turn is this one.
            BlobMetrics.shared.failed()
        } else {
            BlobMetrics.shared.dropped(
                .backgrounded, final: nil, heardChars: text.count, speechMs: BlobMetrics.shared.speechMs,
                parakeetWaitMs: nil, endOfSpeech: endOfSpeech, parakeetState: BlobParakeet.shared.state
            )
        }
        keepUnsent(text, reason: "Blob was closed before it went out.", notice: Self.backgroundNotice)
    }
    /// How long a drop's notice stays while Blob is asleep.
    static let dropNoticeSeconds: Double = 8

    /// Still the same listen: you haven't sent something else since. Only
    /// what you do moves `generation`; the phase is not checked, so nothing
    /// else can drop what you said.
    private func isCurrent(_ listen: Int) -> Bool { generation == listen }

    /// Longest wait for Apple's model to finish its last phrase when you
    /// stop; past it, the text it had shown goes.
    static let stopDeadline: Double = 2

    /// Longest wait for a Parakeet load already under way when you stop.
    /// A first load can take tens of seconds (`BlobParakeet`); the
    /// recording is kept meanwhile, and past this Apple's text goes.
    static let parakeetLoadWait: Double = 15
    /// The same wait when Apple heard nothing: Parakeet is the only text
    /// there will be. A first load on the Neural Engine took about 43 s.
    static let parakeetLoadWaitAlone: Double = 45
    /// The same wait with Fish asked until Parakeet is ready: Fish hears
    /// the recording instead of the wait.
    static let parakeetFishWait: Double = 2
    /// Longest Parakeet may take on the recording once loaded.
    static let parakeetDeadline: Double = 6
    /// Longest wait for Fish, on its own budget after Parakeet's.
    static let fishDeadline: Double = 6

    /// The text a voice turn sends, who wrote it and why, for `BlobMetrics`.
    struct Final {
        var text: String
        var transcriber: BlobMetrics.Transcriber
        var reason: BlobMetrics.TranscriberReason
        /// Time spent in the transcriber that wrote `text`; for Apple, how
        /// long it took to finish its last phrase after you stopped.
        var ms: Int
        /// Why Parakeet, picked, did not write the text when Fish was asked
        /// in its place (`reason` is then `fish` or `fish-missed`).
        var parakeetMiss: BlobMetrics.TranscriberReason?
        /// How long Parakeet's load took, on the first turn that used it.
        var parakeetLoadMs: Int?
        /// How long the recording waited for Parakeet's load after you
        /// stopped; nil when it was loaded, or not loading, by then.
        var parakeetWaitMs: Int?
        /// The Parakeet load still running when this turn gave up on it
        /// (`BlobParakeet.load`); its time is recorded if it finishes.
        var parakeetLoad: Int?
    }

    /// What Parakeet did with the recording, when it answered in time.
    private enum ParakeetAttempt: Sendable {
        case text(String)
        case error
    }

    /// The transcriber you picked, then Apple: the first that answers in
    /// time. Fish hears the recording only when you picked it, or picked
    /// Parakeet with Fish until it is ready (`BlobTranscriber.fishUntilParakeetKey`).
    /// Nil once you moved on from `listen`: the recording goes nowhere else.
    private func finalText(_ said: BlobListener.Heard, stopMs: Int, listen: Int) async -> Final? {
        let appleText = said.text.trimmingCharacters(in: .whitespacesAndNewlines)
        var parakeetMiss: BlobMetrics.TranscriberReason?
        var parakeetLoadMs: Int?
        var parakeetWaitMs: Int?
        var parakeetLoad: Int?
        func used(
            _ transcriber: BlobMetrics.Transcriber, _ reason: BlobMetrics.TranscriberReason, _ text: String, ms: Int
        ) -> Final {
            // A load given up on that finished meanwhile (during Fish's
            // wait): its full time. One still running reports it later.
            if let load = parakeetLoad, let loaded = BlobParakeet.shared.takeLoadMs(of: load) {
                parakeetLoadMs = loaded
                parakeetLoad = nil
            }
            Self.log.info("transcriber used=\(transcriber.rawValue) reason=\(reason.rawValue) parakeetMiss=\(parakeetMiss?.rawValue ?? "-") ms=\(ms) chars=\(text.count) parakeetLoadMs=\(parakeetLoadMs ?? -1) parakeetWaitMs=\(parakeetWaitMs ?? -1)")
            return Final(
                text: text, transcriber: transcriber, reason: reason, ms: ms,
                parakeetMiss: parakeetMiss, parakeetLoadMs: parakeetLoadMs,
                parakeetWaitMs: parakeetWaitMs, parakeetLoad: parakeetLoad
            )
        }
        func apple(_ reason: BlobMetrics.TranscriberReason) -> Final { used(.apple, reason, appleText, ms: stopMs) }
        let choice = BlobTranscriber.current
        if choice == .apple { return apple(.appleChosen) }
        guard said.samples.count >= Int(BlobCapture.sampleRate * 0.3) else { return apple(.tooShort) }
        let samples = said.samples
        if choice == .parakeet {
            let parakeet = BlobParakeet.shared
            let missed: BlobMetrics.TranscriberReason
            // Still loading: wait for it with the recording, saying so.
            let waitBegan = ContinuousClock.now
            let waits = parakeet.state == .loading && hurried != listen
            let fishWaiting = BlobTranscriber.fishUntilParakeet && speaker.server?.transcribe == true
            let limit = fishWaiting ? Self.parakeetFishWait
                : appleText.isEmpty ? Self.parakeetLoadWaitAlone : Self.parakeetLoadWait
            if waits {
                earsFor = listen
                Self.log.info("parakeet wait start limitS=\(limit) appleChars=\(appleText.count) load=\(parakeet.load)")
            }
            let ready = await parakeet.ready(within: waits ? limit : 0) {
                self.generation == listen && self.hurried != listen
            }
            if waits {
                parakeetWaitMs = Self.ms(since: waitBegan)
                if earsFor == listen { earsFor = nil }
                Self.log.info("parakeet wait done ms=\(parakeetWaitMs ?? -1) ready=\(ready) hurried=\(self.hurried == listen) state=\(parakeet.state.wireName)")
            }
            // The wait ended because you moved on: drop the recording.
            guard isCurrent(listen) else { return nil }
            if ready {
                parakeetLoadMs = parakeet.takeLoadMs()
                let language = Self.languageHint
                let began = ContinuousClock.now
                let attempt = await Self.within(Self.parakeetDeadline) { () -> ParakeetAttempt? in
                    do { return .text(try await parakeet.transcribe(samples, language: language)) } catch { return .error }
                }
                switch attempt {
                case .text(let text) where !text.isEmpty: return used(.parakeet, .parakeet, text, ms: Self.ms(since: began))
                case .text: missed = .parakeetEmpty
                case .error: missed = .parakeetError
                case nil: missed = .parakeetDeadline
                }
            } else {
                // A load still running: its time goes on this turn if it
                // finishes while the turn is open, never the part waited.
                if parakeet.state == .loading { parakeetLoad = parakeet.load }
                missed = hurried == listen && parakeet.state == .loading
                    ? .parakeetSkipped : Self.missReason(parakeet.state)
            }
            guard BlobTranscriber.fishUntilParakeet, speaker.server?.transcribe == true,
                  hurried != listen
            else { return apple(missed) }
            parakeetMiss = missed
        }
        guard speaker.server?.transcribe == true, hurried != listen else { return apple(.fishMissed) }
        guard isCurrent(listen) else { return nil }
        let began = ContinuousClock.now
        // No language hint: Fish detects the language itself.
        let text = await Self.within(Self.fishDeadline) { () -> String? in
            let wav = await Task.detached(priority: .userInitiated) { BlobWAV.encode(samples) }.value
            return try? await OS1API.blobTranscribe(wav: wav)
        }
        guard isCurrent(listen) else { return nil }
        if let text, !text.isEmpty { return used(.fish, .fish, text, ms: Self.ms(since: began)) }
        return apple(.fishMissed)
    }

    /// Why Parakeet wasn't ready to hear the recording.
    private static func missReason(_ state: BlobParakeet.State) -> BlobMetrics.TranscriberReason {
        switch state {
        case .absent: .parakeetAbsent
        case .downloading, .paused: .parakeetDownloading
        case .failed: .parakeetFailed
        // Still loading after the wait, or let go on a memory warning and
        // not loaded again in time.
        case .loading, .downloaded, .ready: .parakeetLoadingTimeout
        }
    }

    /// `pl` or `en` from the preferred languages; no hint for anything else.
    static var languageHint: String? {
        guard let first = Locale.preferredLanguages.first,
              let code = Locale(identifier: first).language.languageCode?.identifier,
              code == "pl" || code == "en"
        else { return nil }
        return code
    }

    /// Resumes a continuation once: with `work`'s answer or at the deadline.
    private final class Once<T: Sendable> {
        var continuation: CheckedContinuation<T?, Never>?
        func resume(_ value: T?) { continuation?.resume(returning: value); continuation = nil }
    }

    /// `work`'s answer, or nil once `seconds` pass without one. Returns at
    /// the deadline even when `work` ignores cancellation.
    private static func within<T: Sendable>(_ seconds: Double, _ work: @escaping @MainActor () async -> T?) async -> T? {
        let once = Once<T>()
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
        if let listen = transcribing, listen == generation {
            // What you said is still being written; this replaces it.
            dropVoice(.movedOn, final: nil, listen: listen)
        }
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
    ///
    /// Something sent after this one, while the supervisor was connecting,
    /// doesn't stop it: it still goes, only its reply is no longer the one
    /// on screen. `text` is never empty (`send` drops an empty voice turn).
    private func deliver(_ text: String) async {
        heard = text
        let listen = generation
        sends += 1
        let model: SessionViewModel
        do {
            model = try await supervisorModel()
        } catch {
            // Already kept as unsent when the background time ran out.
            guard expiredListen != listen else { return }
            if isCurrent(listen) {
                couldNotSend(text, error.localizedDescription)
            } else {
                keepEarlier(text, error.localizedDescription)
            }
            return
        }
        guard expiredListen != listen else {
            Self.log.info("deliver skipped: kept as unsent after background expiry chars=\(text.count)")
            return
        }
        let current = isCurrent(listen)
        if current { sentAfter = model.entries.last?.id }
        guard let id = model.sendSteer(text) else {
            if current {
                couldNotSend(text, "The outbox is full.")
            } else {
                keepEarlier(text, "The outbox is full.")
            }
            return
        }
        Self.log.info("deliver enqueued outbox=\(id) chars=\(text.count) running=\(model.isRunning) current=\(current)")
        guard current else { return }
        sentId = id
        sentAt = ContinuousClock.now
    }

    private func couldNotSend(_ text: String, _ reason: String) {
        Self.log.error("deliver failed chars=\(text.count) reason=\(reason)")
        BlobMetrics.shared.failed()
        keepUnsent(text, reason: reason, notice: "Couldn\u{2019}t send. Tap to try again.")
    }

    /// Blob asleep with `text` on screen, to be sent by a tap.
    private func keepUnsent(_ text: String, reason: String, notice: String) {
        unsent = text
        heard = text
        self.notice = notice
        phase = .failed(reason)
    }

    /// A message that didn't go out after you moved on to another: never
    /// only logged. Recorded as dropped, and kept to be sent by a tap: on
    /// screen now when nothing else is, else beside the exchange there,
    /// sent by the tap that would end it (`tap`, `letGo`).
    private func keepEarlier(_ text: String, _ reason: String) {
        Self.log.error("deliver failed after moving on chars=\(text.count) reason=\(reason)")
        BlobMetrics.shared.dropped(
            .movedOn, final: nil, heardChars: text.count, speechMs: nil,
            parakeetWaitMs: nil, endOfSpeech: nil, parakeetState: BlobParakeet.shared.state
        )
        switch phase {
        case .idle, .failed:
            keepUnsent(text, reason: reason, notice: Self.earlierNotice)
        case .listening, .waiting:
            unsent = text
            notice = Self.earlierNotice
        }
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

#if DEBUG
extension BlobTextTalk {
    /// `BLOB_DEMO_HEARD=<words>`: Blob listening with those words heard, for
    /// screenshots without a microphone; with `BLOB_DEMO_THINKING` too,
    /// thinking about them instead.
    func demoHeard(_ words: String, waiting: Bool) {
        heard = words
        phase = waiting ? .waiting : .listening
    }
}
#endif

import Foundation

/// One record per Blob turn, timings and counts only: how the message went
/// in, how long each stage took, how the reply was spoken and how the turn
/// ended. No transcript text and no audio: what you said and what Blob
/// answered appear only as lengths, block kinds and the reply's entry id.
///
/// Turns are buffered on the device (UserDefaults, bounded) and posted in
/// batches to `POST /api/blob/metrics` (server: blob-metrics.ts) when an
/// answer settles, when the app goes to the background and on connect. The
/// owner's review reads them back (`GET /api/blob/review`, the blob-review
/// skill).
///
/// A turn opens when a message goes out (`began`) and closes when the next
/// one starts, when Blob is reset or put away, or when sending fails. It
/// stays open after the answer settles so an interruption of its speech is
/// still counted; a snapshot is queued at settle so the turn reaches the
/// server even if the app is killed before it closes, and the closed turn
/// replaces it there (same `turnId`). `BlobTextTalk` reports each stage; nothing here watches
/// the session itself.
@MainActor
final class BlobMetrics {
    static let shared = BlobMetrics()

    enum Input: String { case voice, typed, chip, ask }
    enum Transcriber: String { case parakeet, fish, apple }
    /// Why a voice turn's text came from the transcriber it came from.
    enum TranscriberReason: String {
        case parakeet
        /// Parakeet picked, not on the device.
        case parakeetAbsent = "parakeet-absent"
        /// Parakeet picked, still downloading or paused mid-download.
        case parakeetDownloading = "parakeet-downloading"
        /// Parakeet on the device but not loaded within the wait after you
        /// stopped (`BlobTextTalk.parakeetLoadWait`).
        case parakeetLoadingTimeout = "parakeet-loading-timeout"
        /// Parakeet's last download or load failed.
        case parakeetFailed = "parakeet-failed"
        /// Parakeet was loaded and threw on the recording.
        case parakeetError = "parakeet-error"
        /// Parakeet was loaded and returned no text.
        case parakeetEmpty = "parakeet-empty"
        /// Parakeet was loaded and missed its deadline.
        case parakeetDeadline = "parakeet-deadline"
        case fish
        /// Fish was asked (or meant to be) and gave no text in time.
        case fishMissed = "fish-missed"
        /// Apple's recognizer is the one picked in Settings.
        case appleChosen = "apple-chosen"
        /// Under 0.3 s of audio: Apple's text without asking anyone else.
        case tooShort = "too-short"
    }
    enum EndOfSpeech: String { case auto, tap }
    enum Interruption: String { case hush, tap }
    enum Outcome: String { case answered, failed, abandoned }

    /// The wire shape; see `BlobTurnMetric` in blob-metrics.ts.
    struct Turn: Codable, Equatable, Sendable {
        var turnId: String
        var startedAt: Int64
        var input: String
        var outcome = Outcome.abandoned.rawValue
        var transcriber: String?
        var transcribeMs: Int?
        var transcriberReason: String?
        var parakeetMiss: String?
        var parakeetLoadMs: Int?
        var parakeetWaitMs: Int?
        var endOfSpeech: String?
        var speechMs: Int?
        var sendToAcceptedMs: Int?
        var acceptedToFirstTokenMs: Int?
        var firstTokenToFirstAudioMs: Int?
        var voice: String?
        var sentencesSpoken: Int?
        var interrupted: String?
        var inputChars: Int?
        var replyChars: Int?
        var blocks: [String]?
        var thinkingSteps: Int?
        var reasked: Bool?
        var appVersion: String?
        var build: String?
        var posture: String?
        var replyEntryId: String?
    }

    private static let pendingKey = "blob.metrics.pending"
    /// Most turns kept on the device while the server is unreachable.
    private static let maxPending = 300
    /// The server takes at most this many turns per request.
    private static let batchSize = 100
    private static let reaskWindow: TimeInterval = 60

    private var current: Turn?
    private var sentAt: ContinuousClock.Instant?
    private var acceptedAt: ContinuousClock.Instant?
    private var firstTokenAt: ContinuousClock.Instant?
    private var listeningAt: ContinuousClock.Instant?
    private var speechMs: Int?
    private var settledAt: Date?
    /// The Parakeet load the open turn gave up waiting for.
    private var awaitedLoad: Int?
    /// The reply's speech was asked for and hasn't started yet.
    private var awaitingAudio = false
    /// The reply is being read aloud, so stopping it is an interruption.
    private var replySpeaking = false
    private var last: (closedAt: Date, inputChars: Int)?
    private var flushing = false

    private var pending: [Turn] {
        get {
            guard let data = UserDefaults.standard.data(forKey: Self.pendingKey) else { return [] }
            return (try? JSONDecoder().decode([Turn].self, from: data)) ?? []
        }
        set {
            let kept = Array(newValue.suffix(Self.maxPending))
            UserDefaults.standard.set(try? JSONEncoder().encode(kept), forKey: Self.pendingKey)
        }
    }

    // MARK: Turn events

    /// The mic opened: speech duration runs from here.
    func listeningStarted() { listeningAt = .now }

    /// You stopped talking (a tap, or the end of speech was heard).
    func speechEnded() {
        speechMs = listeningAt.map { Self.ms(.now - $0) }
        listeningAt = nil
    }

    /// A message is going out. Closes the turn before it, if still open.
    func began(
        _ input: Input,
        inputChars: Int,
        transcriber: Transcriber? = nil,
        transcribeMs: Int? = nil,
        transcriberReason: TranscriberReason? = nil,
        parakeetMiss: TranscriberReason? = nil,
        parakeetLoadMs: Int? = nil,
        parakeetWaitMs: Int? = nil,
        parakeetLoad: Int? = nil,
        endOfSpeech: EndOfSpeech? = nil
    ) {
        close()
        awaitedLoad = parakeetLoad
        var turn = Turn(turnId: UUID().uuidString, startedAt: Int64(Date().timeIntervalSince1970 * 1000), input: input.rawValue)
        turn.inputChars = inputChars
        turn.transcriber = transcriber?.rawValue
        turn.transcribeMs = transcribeMs
        turn.transcriberReason = transcriberReason?.rawValue
        turn.parakeetMiss = parakeetMiss?.rawValue
        turn.parakeetLoadMs = parakeetLoadMs
        turn.parakeetWaitMs = parakeetWaitMs
        turn.endOfSpeech = endOfSpeech?.rawValue
        if input == .voice { turn.speechMs = speechMs }
        if let last, Date().timeIntervalSince(last.closedAt) <= Self.reaskWindow,
           Self.similar(last.inputChars, inputChars) {
            turn.reasked = true
        }
        turn.appVersion = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String
        turn.build = Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as? String
        turn.posture = (BlobSurfaceReport.current?["panes"] as? Int ?? 1) > 1 ? "open" : "closed"
        current = turn
        sentAt = .now
        acceptedAt = nil
        firstTokenAt = nil
        listeningAt = nil
        speechMs = nil
        settledAt = nil
        awaitingAudio = false
        replySpeaking = false
    }

    /// The answer is in: what it showed, how many steps it took. The turn
    /// stays open while it is read aloud.
    func settled(answer: String, replyEntryId: String?, turnEntries: [TranscriptEntry]) {
        guard current != nil, current?.outcome != Outcome.answered.rawValue else { return }
        noteFirstToken()
        current?.outcome = Outcome.answered.rawValue
        settledAt = Date()
        current?.replyChars = answer.count
        current?.replyEntryId = replyEntryId
        let kinds = Self.blockKinds(answer)
        current?.blocks = kinds.isEmpty ? nil : kinds
        current?.thinkingSteps = turnEntries.filter { $0.type == "tool_use" || $0.isReasoning == true }.count
        if let current { queue(current) }
        flush()
    }

    /// Blob is about to read `count` more sentences of the reply aloud.
    func willSpeak(_ count: Int) {
        guard count > 0, current != nil,
              UserDefaults.standard.object(forKey: BlobSpeaker.readAloudKey) as? Bool ?? true
        else { return }
        let spoken = current?.sentencesSpoken ?? 0
        current?.sentencesSpoken = spoken + count
        if !replySpeaking { awaitingAudio = true }
        replySpeaking = true
    }

    /// Audio started playing. Counts only for the reply Blob was asked to
    /// read, not a decision or an ask read on its own.
    func audioStarted(voice: String) {
        guard awaitingAudio, current != nil else { return }
        awaitingAudio = false
        current?.voice = voice
        if let firstTokenAt { current?.firstTokenToFirstAudioMs = Self.ms(.now - firstTokenAt) }
    }

    /// Parakeet finished load number `load`, `ms` after `warm()` began it.
    /// The open turn that fell back because that load was still running
    /// records its time. False when no open turn waited for it.
    @discardableResult
    func parakeetLoaded(ms: Int, load: Int) -> Bool {
        guard current != nil, awaitedLoad == load else { return false }
        awaitedLoad = nil
        // `close()` buffers the turn with it.
        current?.parakeetLoadMs = ms
        return true
    }

    /// Blob's speech is about to be stopped by you: counted when it was
    /// reading this turn's reply.
    func stopping(speaking: Bool, by kind: Interruption = .tap) {
        guard speaking, replySpeaking, current != nil else { return }
        current?.interrupted = kind.rawValue
        replySpeaking = false
    }

    /// The message never reached the supervisor.
    func failed() {
        guard current != nil, current?.outcome != Outcome.answered.rawValue else { return }
        current?.outcome = Outcome.failed.rawValue
        close()
    }

    /// Blob was reset or put away: the open turn ends as it stands.
    func close() {
        guard var turn = current else { return }
        current = nil
        if turn.sendToAcceptedMs == nil, let sentAt, let acceptedAt { turn.sendToAcceptedMs = Self.ms(acceptedAt - sentAt) }
        // A re-ask is measured from when the answer before it settled.
        last = (settledAt ?? Date(timeIntervalSince1970: TimeInterval(turn.startedAt) / 1000), turn.inputChars ?? 0)
        queue(turn)
    }

    /// Buffers `turn`, replacing an earlier snapshot of the same turn.
    private func queue(_ turn: Turn) {
        var queue = pending.filter { $0.turnId != turn.turnId }
        queue.append(turn)
        pending = queue
    }

    /// Closes the open turn and posts what is buffered: the app is going
    /// to the background.
    func background() {
        close()
        flush()
    }

    // MARK: Stages

    /// The server has the message (`BlobTextTalk.accepted`).
    func accepted() { noteAccepted() }

    /// The reply's first words are streaming in (`BlobTextTalk.answerStreamed`).
    func firstToken() { noteFirstToken() }

    private func noteAccepted() {
        guard acceptedAt == nil, let sentAt else { return }
        let now = ContinuousClock.Instant.now
        acceptedAt = now
        current?.sendToAcceptedMs = Self.ms(now - sentAt)
    }

    private func noteFirstToken() {
        guard firstTokenAt == nil else { return }
        noteAccepted()
        let now = ContinuousClock.Instant.now
        firstTokenAt = now
        if let acceptedAt { current?.acceptedToFirstTokenMs = Self.ms(now - acceptedAt) }
    }

    // MARK: Sending

    /// Posts buffered turns, oldest first, a batch at a time until none
    /// are left. A failed post keeps them for the next try. Nothing is sent
    /// until the app knows whose turns they are.
    func flush() {
        guard !flushing, ServerConfig.shared.isConfigured, let base = ServerConfig.shared.baseURL else { return }
        let user = ServerConfig.shared.userName.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !user.isEmpty, !pending.isEmpty else { return }
        flushing = true
        Task {
            defer { flushing = false }
            while true {
                let batch = Array(pending.prefix(Self.batchSize))
                guard !batch.isEmpty else { return }
                var request = ServerConfig.shared.authorizedRequest(base.appending(path: "api/blob/metrics"))
                request.httpMethod = "POST"
                request.setValue("application/json", forHTTPHeaderField: "Content-Type")
                struct Body: Encodable { let user: String; let turns: [Turn] }
                request.httpBody = try? JSONEncoder().encode(Body(user: user, turns: batch))
                guard let (_, response) = try? await URLSession.shared.data(for: request),
                      let status = (response as? HTTPURLResponse)?.statusCode
                else { return }
                // 400 means the server will never take this batch: drop it
                // rather than retry it forever.
                guard status == 200 || status == 400 else { return }
                // Only what was sent: a newer snapshot of the same turn,
                // queued while this post was out, stays for the next batch.
                pending = pending.filter { !batch.contains($0) }
                guard status == 200 else { return }
            }
        }
    }

    // MARK: Helpers

    static func elapsedMs(since start: ContinuousClock.Instant) -> Int { ms(.now - start) }

    private static func ms(_ duration: Duration) -> Int {
        let (seconds, attoseconds) = duration.components
        return max(0, Int(seconds) * 1000 + Int(attoseconds / 1_000_000_000_000_000))
    }

    private static func similar(_ a: Int, _ b: Int) -> Bool {
        guard a > 0, b > 0 else { return false }
        return Double(min(a, b)) / Double(max(a, b)) >= 0.7
    }

    /// The block kinds a reply shows (docs/blocks.md): fenced block
    /// languages, plus `table`, `list` and `heading` for plain markdown.
    static func blockKinds(_ markdown: String) -> [String] {
        var kinds: [String] = []
        var inFence = false
        func add(_ kind: String) { if !kinds.contains(kind) { kinds.append(kind) } }
        for raw in markdown.components(separatedBy: "\n") {
            let line = raw.trimmingCharacters(in: .whitespaces)
            if line.hasPrefix("```") || line.hasPrefix("~~~") {
                if !inFence {
                    let lang = line.dropFirst(3).prefix { $0.isLetter || $0.isNumber || $0 == "-" || $0 == "_" }.lowercased()
                    add(lang.isEmpty ? "code" : String(lang.prefix(32)))
                }
                inFence.toggle()
                continue
            }
            if inFence { continue }
            if line.hasPrefix("|") { add("table") }
            else if line.hasPrefix("#") { add("heading") }
            else if line.hasPrefix("- ") || line.hasPrefix("* ") || line.first?.isNumber == true && line.contains(". ") { add("list") }
        }
        return kinds
    }
}

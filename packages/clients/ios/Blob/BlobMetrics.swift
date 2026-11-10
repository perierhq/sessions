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
/// still counted. `BlobTextTalk` reports each stage; nothing here watches
/// the session itself.
@MainActor
final class BlobMetrics {
    static let shared = BlobMetrics()

    enum Input: String { case voice, typed, chip, ask }
    enum Transcriber: String { case parakeet, fish, apple }
    enum EndOfSpeech: String { case auto, tap }
    enum Interruption: String { case hush, tap }
    enum Outcome: String { case answered, failed, abandoned }

    /// The wire shape; see `BlobTurnMetric` in blob-metrics.ts.
    struct Turn: Codable, Sendable {
        var turnId: String
        var startedAt: Int64
        var input: String
        var outcome = Outcome.abandoned.rawValue
        var transcriber: String?
        var transcribeMs: Int?
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
        endOfSpeech: EndOfSpeech? = nil
    ) {
        close()
        var turn = Turn(turnId: UUID().uuidString, startedAt: Int64(Date().timeIntervalSince1970 * 1000), input: input.rawValue)
        turn.inputChars = inputChars
        turn.transcriber = transcriber?.rawValue
        turn.transcribeMs = transcribeMs
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
        var queue = pending
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

    /// Posts buffered turns, oldest first. A failed post keeps them for the
    /// next try.
    func flush() {
        guard !flushing, ServerConfig.shared.isConfigured, let base = ServerConfig.shared.baseURL else { return }
        let batch = Array(pending.prefix(Self.batchSize))
        guard !batch.isEmpty else { return }
        flushing = true
        Task {
            defer { flushing = false }
            var request = ServerConfig.shared.authorizedRequest(base.appending(path: "api/blob/metrics"))
            request.httpMethod = "POST"
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            struct Body: Encodable { let user: String; let turns: [Turn] }
            request.httpBody = try? JSONEncoder().encode(Body(user: ServerConfig.shared.userName, turns: batch))
            guard let (_, response) = try? await URLSession.shared.data(for: request),
                  let status = (response as? HTTPURLResponse)?.statusCode
            else { return }
            // 400 means the server will never take this batch: drop it
            // rather than retry it forever.
            guard status == 200 || status == 400 else { return }
            let sent = Set(batch.map(\.turnId))
            pending = pending.filter { !sent.contains($0.turnId) }
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

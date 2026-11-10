import Foundation
import Observation

/// Talking to Blob when the server has no voice key: you speak, Apple's
/// on-device recognizer (`BlobListener`) turns it into text, the text goes to
/// the supervisor like a typed message, and Blob shows the answer and reads its
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

    private func send() {
        phase = .waiting
        Task {
            let text = await listener.stop().trimmingCharacters(in: .whitespacesAndNewlines)
            await deliver(text)
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

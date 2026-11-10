import SwiftUI

/// One short line above Blob while the supervisor works on your message:
/// "Reading my notes", "Reading PR #212 · 12s". Tap it for this turn's steps
/// with their times. It fades out when the answer starts or a question card
/// comes up. Labels come from `BlobSteps`; this file reads the transcript
/// and draws them, and plays the voice filler (`BlobFiller`).
struct BlobThinkingLayer: View {
    let talk: BlobTextTalk
    /// Where Blob sits while it thinks; the line goes just above it.
    let blobCenter: CGPoint
    let blobRadius: CGFloat
    /// History is open.
    let hidden: Bool

    @State private var turn = BlobThinkingTurn()
    @State private var showSteps = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        TimelineView(.animation(minimumInterval: 1, paused: !(turn.demo || showing))) { timeline in
            let steps = turn.steps(at: timeline.date)
            let current = BlobSteps.current(steps, at: timeline.date)
            let visible = !hidden && current != nil && (turn.demo || showing)
            Group {
                if visible, let current {
                    Button { showSteps = true } label: {
                        Text(BlobSteps.line(current, at: timeline.date))
                            .id(current.label)
                            .transition(.opacity)
                            .font(.footnote)
                            .foregroundStyle(OS1VisualStyle.textDim)
                            .monospacedDigit()
                            .lineLimit(1)
                            .padding(.horizontal, 12)
                            .padding(.vertical, 6)
                            .background(Capsule().fill(OS1VisualStyle.hover))
                            .contentShape(Capsule())
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel(current.label)
                    .accessibilityHint("Shows what Blob has done so far")
                    .animation(reduceMotion ? nil : .easeInOut(duration: 0.25), value: current.label)
                    .onChange(of: current.label, initial: true) { _, _ in turn.announce(current) }
                    .transition(.opacity)
                }
            }
            .frame(maxWidth: 320)
            .position(x: blobCenter.x, y: blobCenter.y - blobRadius - 28)
            .animation(.easeOut(duration: 0.2), value: visible)
        }
        .sheet(isPresented: $showSteps) {
            BlobStepsSheet(turn: turn)
                #if os(macOS)
                .frame(minWidth: 320, idealWidth: 360, minHeight: 240, idealHeight: 360)
                #endif
        }
        // One new turn per message; the anchor settles after it without
        // restarting the filler's wait.
        .onChange(of: talk.sends, initial: true) { _, _ in
            if talk.phase == .waiting { turn.begin(talk: talk) }
        }
        .onChange(of: talk.phase == .waiting) { _, waiting in if !waiting { turn.finish() } }
        .onChange(of: anchorKey) { _, _ in turn.update(talk: talk) }
        .onChange(of: talk.answer != nil, initial: true) { _, speaking in if speaking { turn.answerStreaming() } }
        .onChange(of: talk.replyEntry?.id, initial: true) { _, _ in turn.checkReply(talk: talk) }
        .onChange(of: entryKey) { _, _ in turn.update(talk: talk) }
        .onChange(of: talk.desk?.pendingQuestion != nil, initial: true) { _, asking in if asking { turn.questionShown() } }
    }

    /// The live line, outside the demo: the supervisor is still working and
    /// nothing of the answer or a question card is on screen yet.
    private var showing: Bool {
        talk.thinking && !turn.started && talk.desk?.pendingQuestion == nil
    }

    /// Where the turn's entries start: settles a beat after the message goes out.
    private var anchorKey: String {
        "\(talk.sentAfter ?? "")|\(talk.heard)"
    }

    /// Changes when the turn's transcript does, including when a live tool
    /// call gets its arguments. Empty while nothing is shown, so streamed
    /// answer tokens don't rebuild it.
    private var entryKey: [String] {
        guard !turn.started, talk.thinking else { return [] }
        return talk.turnEntries.map { "\(BlobThinkingTurn.key($0)):\(BlobThinkingTurn.fingerprint($0.toolInput))" }
    }
}

/// This turn's steps, newest last, with how long each took.
private struct BlobStepsSheet: View {
    let turn: BlobThinkingTurn
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            TimelineView(.periodic(from: .now, by: 1)) { timeline in
                List(turn.steps(at: timeline.date)) { step in
                    HStack {
                        Text(step.label)
                            .foregroundStyle(OS1VisualStyle.text)
                        Spacer()
                        Text(BlobSteps.duration(step.seconds(at: timeline.date)))
                            .font(.footnote)
                            .monospacedDigit()
                            .foregroundStyle(OS1VisualStyle.textFaint)
                    }
                    .accessibilityElement(children: .combine)
                }
            }
            .navigationTitle("Steps")
            #if os(iOS)
            .navigationBarTitleDisplayMode(.inline)
            #endif
            .toolbar {
                ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } }
            }
        }
        #if os(iOS)
        .presentationDetents([.medium, .large])
        #endif
    }
}

/// One turn's steps: when the message went out, when each entry after it
/// was first seen, and whether the answer has started. Times are the
/// device's own, so a live step's seconds never drift with the server clock.
@MainActor
@Observable
final class BlobThinkingTurn {
    private(set) var sentAt: Date?
    private(set) var finishedAt: Date?
    /// The answer has started this turn; the line stays hidden after that.
    private(set) var started = false
    private var events: [BlobStepEvent] = []
    @ObservationIgnored private var seen: [String: Date] = [:]
    @ObservationIgnored let filler = BlobFiller()
    @ObservationIgnored private var fillerTask: Task<Void, Never>?
    @ObservationIgnored private var announcing: Task<Void, Never>?
    @ObservationIgnored private var announced: String?
    @ObservationIgnored private var persona: String?

    #if DEBUG
    let demo = ProcessInfo.processInfo.environment["BLOB_DEMO_THINKING"] != nil
    @ObservationIgnored private let demoStart = Date()
    #else
    let demo = false
    #endif

    func steps(at now: Date) -> [BlobStep] {
        #if DEBUG
        if demo { return BlobSteps.demo(at: now, since: demoStart) }
        #endif
        guard let sentAt else { return [] }
        var steps = BlobSteps.steps(from: events, sentAt: sentAt, persona: persona)
        if let finishedAt, let last = steps.indices.last, steps[last].end == nil {
            steps[last].end = max(finishedAt, steps[last].start)
        }
        return steps
    }

    /// A message went out: start a new turn, and the filler's 4 s wait.
    func begin(talk: BlobTextTalk) {
        sentAt = Date()
        finishedAt = nil
        started = false
        events = []
        seen = [:]
        announcing?.cancel()
        announced = nil
        persona = InstanceIdentity.shared.personaName
        Task { await InstanceIdentity.shared.ensureLoaded(); persona = InstanceIdentity.shared.personaName }
        update(talk: talk)
        filler.stop()
        fillerTask?.cancel()
        fillerTask = Task { [weak self, weak talk] in
            try? await Task.sleep(for: BlobFiller.delay)
            guard let self, let talk, !Task.isCancelled, !self.started,
                  talk.phase == .waiting, talk.answer == nil, !talk.speaker.speaking,
                  talk.desk?.pendingQuestion == nil
            else { return }
            await self.filler.play(speaker: talk.speaker)
        }
    }

    func finish() {
        if sentAt != nil, finishedAt == nil { finishedAt = Date() }
        quiet()
    }

    /// The finished reply landed: the line stays hidden for the rest of the turn.
    func answerStarted() {
        started = true
        quiet()
    }

    /// Text is streaming. It may be a preamble before a tool call, so the
    /// line only hides while it shows (`BlobTextTalk.thinking`); the filler
    /// stops for good.
    func answerStreaming() { quiet() }

    /// A question card came up: no filler over it.
    func questionShown() { quiet() }

    private func quiet() {
        fillerTask?.cancel()
        filler.stop()
        announcing?.cancel()
    }

    /// Reads the turn's entries into events, each timed when first seen.
    func update(talk: BlobTextTalk) {
        guard sentAt != nil, finishedAt == nil else { return }
        let now = Date()
        events = talk.turnEntries.compactMap { entry in
            let key = Self.key(entry)
            let at = seen[key] ?? now
            seen[key] = at
            switch entry.type {
            case "tool_use":
                let presentation = ToolPresentation.make(toolName: entry.toolName, input: entry.toolInput, server: entry.presentation)
                let known = presentation.family != .other || presentation.mcpServer != nil
                return BlobStepEvent(
                    kind: .tool(name: entry.toolName ?? "", args: Self.scalars(entry.toolInput), title: known ? presentation.displayName : nil),
                    at: at
                )
            case "tool_result": return BlobStepEvent(kind: .result, at: at)
            case "assistant": return BlobStepEvent(kind: .thinking, at: at)
            default: return nil
            }
        }
        checkReply(talk: talk)
    }

    /// Latches `started` once the final reply has landed: an answer with no
    /// tool call after it. A preamble before a tool call doesn't count.
    func checkReply(talk: BlobTextTalk) {
        guard !started, sentAt != nil, let reply = talk.replyEntry else { return }
        let entries = talk.turnEntries
        if let at = entries.lastIndex(where: { $0.id == reply.id }),
           entries[(at + 1)...].contains(where: { $0.type == "tool_use" }) { return }
        answerStarted()
    }

    nonisolated static func key(_ entry: TranscriptEntry) -> String {
        "\(entry.type):\(entry.toolUseId ?? entry.id)"
    }

    /// Cheap stand-in for a call's arguments: field counts, enough to see a
    /// live call's input arrive without hashing it.
    nonisolated static func fingerprint(_ input: JSONValue?) -> String {
        guard case .object(let fields)? = input else { return input == nil ? "-" : "?" }
        if case .object(let inner)? = fields["arguments"] { return "\(fields.count).\(inner.count)" }
        return "\(fields.count)"
    }

    /// VoiceOver hears a step politely once it has stayed on the line for
    /// 2 s, never the opening "Thinking", and never the same label twice
    /// in a row.
    func announce(_ step: BlobStep) {
        let label = step.label
        announcing?.cancel()
        guard label != announced, !(step.id == 0 && label == BlobSteps.thinking) else { return }
        announcing = Task { [weak self] in
            try? await Task.sleep(for: .seconds(2))
            guard let self, !Task.isCancelled, !self.started, self.finishedAt == nil else { return }
            self.announced = label
            var text = AttributedString(label)
            text.accessibilitySpeechAnnouncementPriority = .low
            AccessibilityNotification.Announcement(text).post()
        }
    }

    /// A call's scalar arguments as text, with a `tool_call` envelope's
    /// inner arguments beside its `name`. Only `BlobSteps` reads them, and
    /// it shows nothing but a PR number or a project name.
    private static func scalars(_ input: JSONValue?) -> [String: String] {
        guard case .object(let fields)? = input else { return [:] }
        var out: [String: String] = [:]
        for (key, value) in fields {
            switch value {
            case .string(let text): out[key] = text
            case .number(let number):
                out[key] = number == number.rounded() && abs(number) < 1e15 ? String(Int(number)) : String(number)
            case .bool(let flag): out[key] = String(flag)
            case .object(let inner) where key == "arguments":
                out.merge(scalars(.object(inner))) { old, _ in old }
            default: break
            }
        }
        return out
    }
}

extension BlobTextTalk {
    /// The supervisor's entries after the message you sent, durable then
    /// streamed. Anchored like `replyEntry`: on the user entry carrying what
    /// was said, after where the transcript ended when it went out. Empty
    /// until that entry lands.
    var turnEntries: [TranscriptEntry] {
        guard let desk, phase == .waiting else { return [] }
        let entries = desk.entries
        let floor = sentAfter.flatMap { id in entries.lastIndex { $0.id == id } }.map { $0 + 1 } ?? 0
        guard floor < entries.count else { return [] }
        let said = heard.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let mine = entries[floor...].lastIndex(where: { entry in
            entry.type == "user" && (said.isEmpty || (entry.content ?? "").contains(said))
        }) else { return [] }
        let durable = Array(entries[entries.index(after: mine)...])
        let landed = Set(durable.map(BlobThinkingTurn.key))
        return durable + desk.liveEntries.filter { !landed.contains(BlobThinkingTurn.key($0)) }
    }
}

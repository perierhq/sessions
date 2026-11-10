import SwiftUI

/// While the supervisor works on your message, Blob thinks it: a soft
/// thought beside its head, joined to it by two small circles, saying what
/// it is doing ("Reading my notes", "Reading PR #212 · 12s"), or three
/// quiet dots before there is a step. Tap it for this turn's steps with
/// their times. It goes when the answer starts or a question card comes
/// up. Labels come from `BlobSteps`; this file reads the transcript, draws
/// the thought (`BlobThought`) and plays the voice filler (`BlobFiller`).
struct BlobThinkingLayer: View {
    let talk: BlobTextTalk
    /// Blob's body, read every frame so the thought follows it as it moves
    /// and shrinks.
    let physics: BlobPhysics
    /// Where the thought may go, in the same space as Blob: inside the safe
    /// area and above the controls at the bottom.
    let bounds: CGRect
    /// A physical fold (the open Duo's): the thought stays on Blob's side.
    let fold: CGRect?
    /// History is open.
    let hidden: Bool

    @State private var turn = BlobThinkingTurn()
    @State private var showSteps = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        TimelineView(.animation(minimumInterval: 1, paused: !(turn.demo || showing))) { timeline in
            let steps = turn.steps(at: timeline.date)
            let current = BlobSteps.current(steps, at: timeline.date)
            let visible = !hidden && (turn.demo || showing)
            ZStack {
                if visible {
                    // The opening "Thinking" is the dots: a thought that says
                    // it is thinking says nothing.
                    let step = current.flatMap { $0.label == BlobSteps.thinking ? nil : $0 }
                    BlobThought(
                        key: step?.label,
                        line: step.map { BlobSteps.line($0, at: timeline.date) },
                        physics: physics,
                        bounds: bounds,
                        fold: fold
                    ) { showSteps = true }
                    .onChange(of: current?.label, initial: true) { _, _ in
                        if let current { turn.announce(current) }
                    }
                    .transition(.opacity.animation(.easeOut(duration: 0.2)))
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
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

    /// The live thought, outside the demo: the supervisor is still working
    /// and nothing of the answer or a question card is on screen yet.
    private var showing: Bool {
        talk.thinking && !turn.started && talk.desk?.pendingQuestion == nil
    }

    /// Where the turn's entries start: settles a beat after the message goes out.
    private var anchorKey: String {
        "\(talk.sentAfter ?? "")|\(talk.acceptedEntry?.id ?? "")|\(talk.heard)"
    }

    /// Changes when the turn's transcript does, including when a live tool
    /// call gets its arguments. Empty while nothing is shown, so streamed
    /// answer tokens don't rebuild it.
    private var entryKey: [String] {
        guard !turn.started, talk.thinking else { return [] }
        return talk.turnEntries.map { "\(BlobThinkingTurn.key($0)):\(BlobThinkingTurn.fingerprint($0.toolInput))" }
    }
}

/// The thought itself, placed every frame from where Blob is: two small
/// circles off the top of its head, then the bubble, on whichever side has
/// room (the side its eyes glance to, unless that edge is too close). It
/// emerges from Blob, tail first; a new step's bubble forms as the old one
/// drifts up and fades; it bobs a few points while it waits. Under Reduce
/// Motion it stays still and only fades.
private struct BlobThought: View {
    /// The step on it; nil for the dots.
    let key: String?
    let line: String?
    let physics: BlobPhysics
    let bounds: CGRect
    let fold: CGRect?
    let tap: () -> Void

    /// 0 hidden, then each circle of the tail, then the bubble.
    @State private var stage = 0
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        TimelineView(.animation) { timeline in
            let t = timeline.date.timeIntervalSinceReferenceDate
            let shape = Self.shape(center: physics.position, radius: physics.radius, bounds: bounds, fold: fold)
            let drift = reduceMotion ? .zero : CGSize(
                width: 1.5 * sin(t * 2 * .pi / 5.3),
                height: 2.5 * sin(t * 2 * .pi / 3.7)
            )
            ZStack(alignment: .topLeading) {
                tailDot(shape.near, size: 6, drift: drift, scale: 0.3, shown: stage >= 1)
                tailDot(shape.far, size: 10, drift: drift, scale: 0.6, shown: stage >= 2)
                ThoughtPlacement(anchor: shape.anchor, trailing: shape.trailing, area: shape.area) {
                    if stage >= 3 {
                        bubble(t: t)
                            .id(key ?? "")
                            .transition(stepTransition(trailing: shape.trailing))
                    }
                }
                .offset(drift)
                .animation(reduceMotion ? .easeOut(duration: 0.2) : .smooth(duration: 0.45), value: key)
            }
        }
        .onAppear(perform: emerge)
    }

    /// The tail end grows first, then the bubble, each from Blob outward.
    private func emerge() {
        guard !reduceMotion else {
            withAnimation(.easeOut(duration: 0.2)) { stage = 3 }
            return
        }
        for next in 1...3 {
            withAnimation(.spring(duration: 0.35, bounce: 0.15).delay(Double(next - 1) * 0.08)) { stage = next }
        }
    }

    private func tailDot(_ point: CGPoint, size: CGFloat, drift: CGSize, scale: CGFloat, shown: Bool) -> some View {
        Circle()
            .fill(OS1VisualStyle.hover)
            .frame(width: size, height: size)
            .scaleEffect(shown || reduceMotion ? 1 : 0.4)
            .opacity(shown ? 1 : 0)
            .position(x: point.x + drift.width * scale, y: point.y + drift.height * scale)
            .accessibilityHidden(true)
    }

    private func bubble(t: Double) -> some View {
        Button(action: tap) {
            Group {
                if let line {
                    Text(line)
                        .font(.footnote)
                        .foregroundStyle(OS1VisualStyle.textDim)
                        .monospacedDigit()
                        .lineLimit(2)
                        .multilineTextAlignment(.leading)
                        .fixedSize(horizontal: false, vertical: true)
                } else {
                    dots(t: t)
                }
            }
            .padding(.horizontal, 14)
            .padding(.vertical, 8)
            .background(OS1VisualStyle.hover, in: .rect(cornerRadius: 17, style: .continuous))
            .contentShape(.rect(cornerRadius: 17, style: .continuous))
        }
        .buttonStyle(.plain)
        .accessibilityLabel(key ?? BlobSteps.thinking)
        .accessibilityHint("Shows what Blob has done so far")
    }

    /// Three dots that brighten in turn; still under Reduce Motion.
    private func dots(t: Double) -> some View {
        HStack(spacing: 4) {
            ForEach(0..<3, id: \.self) { index in
                let wave = reduceMotion ? 0.5 : max(0, sin(t * 2 * .pi / 1.4 - Double(index) * 0.7))
                Circle()
                    .fill(OS1VisualStyle.textDim)
                    .frame(width: 5, height: 5)
                    .opacity(0.35 + 0.55 * wave)
            }
        }
        .frame(height: 16)
    }

    /// A new step forms from the tail end; the old one drifts up and fades.
    private func stepTransition(trailing: Bool) -> AnyTransition {
        guard !reduceMotion else { return .opacity }
        return .asymmetric(
            insertion: .scale(scale: 0.92, anchor: trailing ? .bottomLeading : .bottomTrailing).combined(with: .opacity),
            // Gone before the new one has fully formed, so the two never
            // read as one muddle.
            removal: .offset(y: -14).combined(with: .opacity).animation(.easeOut(duration: 0.25))
        )
    }

    struct Geometry {
        var near: CGPoint
        var far: CGPoint
        /// The bubble's bottom corner nearest Blob.
        var anchor: CGPoint
        /// The bubble goes to Blob's trailing side.
        var trailing: Bool
        /// Where the bubble may go.
        var area: CGRect
    }

    /// Where the tail and the bubble go for Blob at `center`. The tail
    /// leaves the head at about 50° up, toward the side with room; the
    /// bubble's area stops at a physical fold on Blob's side of it.
    static func shape(center: CGPoint, radius: CGFloat, bounds: CGRect, fold: CGRect?) -> Geometry {
        var area = bounds
        if let fold {
            if center.x < fold.midX {
                area.size.width = max(0, min(area.maxX, fold.minX) - area.minX)
            } else {
                let minX = max(area.minX, fold.maxX)
                area.size.width = max(0, area.maxX - minX)
                area.origin.x = minX
            }
        }
        let trailing = area.maxX - (center.x + radius * 0.6) >= 140 || area.maxX - center.x >= center.x - area.minX
        let sign: CGFloat = trailing ? 1 : -1
        let near = CGPoint(x: center.x + sign * (radius + 8) * 0.64, y: center.y - (radius + 8) * 0.77)
        let far = CGPoint(x: center.x + sign * (radius + 22) * 0.6, y: center.y - (radius + 22) * 0.8)
        let anchor = CGPoint(x: far.x - sign * 10, y: far.y - 9)
        return Geometry(near: near, far: far, anchor: anchor, trailing: trailing, area: area)
    }
}

/// Places the thought's bubble with its bottom corner at `anchor`, growing
/// away from Blob, then slides it back inside `area` if it would leave it.
private struct ThoughtPlacement: Layout {
    var anchor: CGPoint
    var trailing: Bool
    var area: CGRect

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        proposal.replacingUnspecifiedDimensions()
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        let maxWidth = max(60, min(area.width, 280))
        for subview in subviews {
            let size = subview.sizeThatFits(ProposedViewSize(width: maxWidth, height: nil))
            var x = trailing ? anchor.x : anchor.x - size.width
            x = min(max(x, area.minX), max(area.minX, area.maxX - size.width))
            let y = max(anchor.y - size.height, area.minY)
            subview.place(
                at: CGPoint(x: bounds.minX + x, y: bounds.minY + y),
                anchor: .topLeading,
                proposal: ProposedViewSize(width: size.width, height: size.height)
            )
        }
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

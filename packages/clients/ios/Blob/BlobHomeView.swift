import SwiftUI

/// Blob's home: an empty screen with Blob asleep in its slot. Tap it to talk;
/// it moves to the middle, listens and answers through the supervisor's live voice
/// call, then goes back to its slot when you tap it again.
///
/// Talking is a tap, not hold-to-talk: the live call takes a few seconds to
/// connect, and holding would cut off the first words of every sentence.
struct BlobHomeView: View {
    private let engine = DeskVoiceEngine.supervisor
    /// Used instead of the voice call when the server has no voice key.
    @State private var text = BlobTextTalk()
    /// Nil until the server answers; voice stays the default when it can't say.
    @State private var voiceConfigured: Bool?
    /// The OpenAI live call is billed per minute, so it is opt-in. Off, Blob
    /// listens on the device and reads its answers aloud.
    @AppStorage(BlobSpeaker.liveCallKey) private var liveCall = false
    @State private var physics = BlobPhysics()
    /// What the supervisor is waiting on you for, shown while Blob is idle.
    @State private var decisions = BlobDecisions()
    /// Room a reply may take: the screen below Blob, minus what you said.
    @State private var replyHeight: CGFloat = 420
    @State private var showSettings = false
    /// Writing instead of speaking.
    @State private var typing = false
    @State private var draft = ""
    /// Earlier exchanges, opened with a swipe up.
    @State private var historyOpen = false
    /// Whether a long reply is scrolled to its end, so a swipe up there opens
    /// history instead of fighting the reply's own scrolling.
    @State private var replyAtEnd = true
    @State private var dragStartedAtEnd: Bool?
    @FocusState private var fieldFocused: Bool
    @AppStorage("blob.hasTalked") private var hasTalked = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.scenePhase) private var scenePhase

    var body: some View {
        // The outer reader only measures the safe area; the inner one draws
        // full bleed so Blob can sit in the Duo's system strip.
        GeometryReader { outer in
            let insets = outer.safeAreaInsets
            GeometryReader { geo in
            ZStack(alignment: .bottom) {
                if historyOpen {
                    BlobHistoryView(
                        exchanges: text.history,
                        relay: text.relay,
                        canLoadEarlier: text.canLoadEarlier,
                        loadingEarlier: text.loadingEarlier,
                        loadEarlier: { text.loadEarlier() },
                        dismiss: closeHistory,
                        margins: Self.historyMargins(insets: insets)
                    )
                    .transition(reduceMotion ? .opacity : .offset(y: 48).combined(with: .opacity))
                }

                // Drawn over history, so Blob stays visible in its slot, but
                // never in the way of a scroll: taps are handled below.
                TimelineView(.animation(paused: scenePhase != .active)) { timeline in
                    let targets = targets(in: geo.size, insets: insets, at: timeline.date)
                    Canvas { context, _ in
                        physics.advance(to: timeline.date, targets: targets)
                        physics.draw(in: &context, dark: colorScheme == .dark, reduceMotion: reduceMotion)
                    }
                }
                .allowsHitTesting(false)
                .accessibilityElement()
                .accessibilityLabel("Blob")
                .accessibilityValue(historyOpen ? "History" : talking ? statusLabel : showingDecision ? "Needs you" : "Asleep")
                .accessibilityHint(historyOpen ? "Closes history" : talking ? "Ends the conversation" : "Starts a conversation")
                .accessibilityAddTraits(.isButton)
                .accessibilityAction { historyOpen ? closeHistory() : toggleTalk() }
                .accessibilityAction(named: historyOpen ? "Close history" : "Show history") {
                    historyOpen ? closeHistory() : openHistory()
                }

                // What the supervisor is doing, just above Blob while it thinks.
                BlobThinkingLayer(
                    talk: text,
                    blobCenter: CGPoint(x: insets.leading + (geo.size.width - insets.leading - insets.trailing) / 2, y: geo.size.height * 0.4),
                    blobRadius: 66,
                    hidden: historyOpen
                )

                if !historyOpen {
                    captions(insets: insets)
                        .transition(.opacity)
                }
            }
            .contentShape(Rectangle())
            .simultaneousGesture(historySwipe)
            .onTapGesture(coordinateSpace: .local) { location in
                if historyOpen {
                    if hit(location) { closeHistory() }
                } else if hit(location) {
                    toggleTalk()
                } else if typing && draft.isEmpty {
                    typing = false
                    fieldFocused = false
                }
            }
            .onLongPressGesture { showSettings = true }
            .onAppear {
                replyHeight = max(240, geo.size.height - insets.top - insets.bottom - 220)
                BlobSurfaceReport.update(size: geo.size)
            }
            .onChange(of: geo.size) { _, size in
                replyHeight = max(240, size.height - insets.top - insets.bottom - 220)
                BlobSurfaceReport.update(size: size)
            }
            }
            .ignoresSafeArea()
        }
        // Outside the full-bleed layer so it rides above the keyboard.
        .overlay(alignment: .bottom) { writeBar }
        .background(OS1VisualStyle.background.ignoresSafeArea())
        .sheet(isPresented: $showSettings) {
            BlobSettingsView(speaker: text.speaker)
                #if os(macOS)
                .frame(minWidth: 380, idealWidth: 400, minHeight: 440, idealHeight: 520)
                #endif
        }
        .onChange(of: text.listener.text) { _, _ in text.syncHeard() }
        .onChange(of: text.settled) { _, settled in if settled { text.answerSettled() } }
        .animation(reduceMotion ? nil : .easeOut(duration: 0.2), value: typing)
        .onChange(of: text.phase) { _, phase in
            // A chip tapped in history is the next thing you say: its answer
            // comes on the home.
            if phase == .waiting, historyOpen { closeHistory() }
        }
        .task {
            text.connect()
            voiceConfigured = await BlobTextTalk.voiceConfigured()
        }
        // Open decisions: on appear, when the app comes back, and every
        // minute while it is in front.
        .task(id: scenePhase) {
            guard scenePhase == .active else { return }
            while !Task.isCancelled {
                await decisions.refresh()
                try? await Task.sleep(for: .seconds(60))
            }
        }
        .haptic(.commit, trigger: decisions.answered)
        // Blob reads a decision's first paragraph when it comes up, once.
        .onChange(of: decision?.id, initial: true) { old, new in
            if old != nil, old != new { text.speaker.stop() }
            if let decision, decisions.shouldSpeak(decision) {
                let say = BlobReply(decision.body).say
                if !say.isEmpty { text.speaker.speak(say) }
            }
        }
        // A Bark notification's link: `blob://item/<id>` shows that item as
        // the current decision; `blob://` alone just opens Blob.
        .onOpenURL { url in
            guard let id = BlobLink.itemId(url) else { return }
            if historyOpen { closeHistory() }
            if typing && draft.isEmpty { typing = false; fieldFocused = false }
            if text.phase != .listening { text.reset() }
            Task { await decisions.focus(id: id) }
        }
        .animation(reduceMotion ? .easeOut(duration: 0.2) : .smooth(duration: 0.35), value: decisionKey)
        #if DEBUG
        .onAppear {
            if ProcessInfo.processInfo.environment["BLOB_DEMO_TYPING"] != nil {
                draft = "what shipped this week?"
                typing = true
            }
            if BlobExchange.demoOpen { historyOpen = true }
        }
        #endif
        #if os(macOS)
        .modifier(BlobMacKeys(space: spaceKey, escape: escapeKey))
        .onChange(of: mode, initial: true) { _, mode in BlobMacState.shared.mode = mode }
        .onChange(of: menuStatus, initial: true) { _, status in BlobMacState.shared.status = status }
        .onChange(of: decisions.waiting, initial: true) { _, count in BlobMacState.shared.waiting = count }
        .onChange(of: BlobMacState.shared.request) { _, request in
            guard let request else { return }
            BlobMacState.shared.request = nil
            switch request {
            case .write: startWriting()
            case .history: historyOpen ? closeHistory() : openHistory()
            case .settings: showSettings = true
            }
        }
        #endif
        .onChange(of: scenePhase) { _, phase in
            // A backgrounded app must never hold the mic open.
            if phase == .background {
                if !engine.shownOutsideApp { engine.stop() }
                text.reset()
            }
        }
    }

    #if os(macOS)
    /// One line for the menu bar item.
    private var menuStatus: String {
        if talking { return statusLabel.isEmpty ? "Talking" : statusLabel }
        return showingDecision ? "Needs you" : "Asleep"
    }

    /// Space talks, or stops talking. Not while history is open.
    private func spaceKey() -> Bool {
        guard !historyOpen else { return false }
        toggleTalk()
        return true
    }

    /// Esc stops Blob reading, then closes history, then the write bar.
    private func escapeKey() -> Bool {
        if text.speaker.speaking {
            text.speaker.stop()
        } else if historyOpen {
            closeHistory()
        } else if typing && draft.isEmpty {
            typing = false
            fieldFocused = false
        } else {
            return false
        }
        return true
    }
    #endif

    #if os(macOS)
    private static let talkHint = "Click me or press Space to talk"
    #else
    private static let talkHint = "Tap me to talk"
    #endif

    private func startWriting() {
        if historyOpen { closeHistory() }
        typing = true
        fieldFocused = true
    }

    /// The live voice call: only when turned on in settings and the server
    /// has a voice key.
    private var usesVoice: Bool { liveCall && voiceConfigured != false }
    /// Typed messages, and speech without a voice key, go through `text`.
    private var talking: Bool { engine.active || text.active }
    private var textConversation: Bool { text.active || !usesVoice }

    /// Nothing else going on: no conversation, no typing, no history, no
    /// reply on screen. Only then does a decision come up.
    private var idle: Bool {
        !talking && !typing && !historyOpen && !replyOnScreen && !Self.demoRunning
    }

    /// The decision on screen, if Blob is idle and one is waiting.
    private var decision: OS1API.SupervisorItem? {
        idle && decisions.said == nil ? decisions.current : nil
    }

    /// What Blob says after an answer, while idle.
    private var decisionSaid: String? { idle ? decisions.said : nil }

    /// Blob is awake for a decision: showing one, or just confirming one.
    private var showingDecision: Bool { decision != nil || decisionSaid != nil }

    /// Changes whenever the decision surface does, for its animation.
    private var decisionKey: String { decisionSaid ?? decision?.id ?? "" }

    private var statusLabel: String {
        if !textConversation { return engine.state.label }
        switch text.phase {
        case .listening: return "Listening"
        case .waiting: return text.thinking ? "Thinking" : "Answering"
        default: return ""
        }
    }

    private var mode: BlobMode {
        #if DEBUG
        if let demo = BlobDemo.current { return demo.mode }
        #endif
        if typing && !text.active { return draft.isEmpty ? .quiet : .listen }
        if textConversation {
            // Typed, or no voice key: Blob answers in text (and may read it
            // aloud with an Apple voice).
            switch text.phase {
            case .idle, .failed: return .quiet
            case .listening: return .listen
            case .waiting: return text.thinking ? .think : .speak
            }
        }
        return switch engine.state {
        case .idle, .error: .quiet
        case .connecting, .thinking, .action: .think
        case .listening: .listen
        case .speaking: .speak
        }
    }

    /// Asleep in the bottom trailing corner, under the thumb; in the middle and
    /// bigger while you talk.
    private func targets(in size: CGSize, insets: EdgeInsets, at date: Date) -> BlobTargets {
        let center = CGPoint(x: insets.leading + (size.width - insets.leading - insets.trailing) / 2, y: size.height * 0.4)
        let slot = Self.slot(in: size, insets: insets)
        var talking = talking, mode = mode, level = textConversation ? text.level(at: date) : Double(engine.audioLevel)
        #if DEBUG
        if let demo = BlobDemo.at(date) { talking = demo.talking; mode = demo.mode; level = demo.level }
        #endif
        // A reply on screen gets the room: Blob moves up and keeps talking from there.
        let showingReply = text.answer != nil || Self.demoReply != nil
        let top = CGPoint(x: center.x, y: max(insets.top, 20) + 56)
        // History gets the screen; Blob waits in its slot, small.
        if historyOpen { talking = false }
        // Something needs you: Blob wakes and moves up, as for a reply.
        if !talking && showingDecision {
            let reading = text.speaker.speaking
            return BlobTargets(
                mode: decisionSaid != nil || reading ? .speak : .you,
                position: top,
                size: 72,
                look: nil,
                level: reading ? text.speaker.level(at: date) : 0
            )
        }
        return BlobTargets(
            mode: mode,
            position: talking ? (showingReply ? top : center) : slot,
            size: talking ? (showingReply ? 72 : 132) : 48,
            look: nil,
            level: level
        )
    }

    /// Blob's resting place. On the Duo's outer display the system keeps an
    /// 84 pt strip on the hardware edge for the camera, the time and the bars;
    /// Blob sits low in that strip, where the system puts a vertical tab bar.
    /// Anywhere else it rests in the bottom trailing corner.
    private static func slot(in size: CGSize, insets: EdgeInsets) -> CGPoint {
        let bottom = size.height - max(insets.bottom, 30) - 48
        if insets.trailing >= 60 { return CGPoint(x: size.width - insets.trailing + 36, y: bottom) }
        if insets.leading >= 60 { return CGPoint(x: insets.leading - 36, y: bottom) }
        return CGPoint(x: size.width - insets.trailing - 44, y: size.height - insets.bottom - 40)
    }

    private func hit(_ location: CGPoint) -> Bool {
        let p = physics.position
        return hypot(location.x - p.x, location.y - p.y) <= max(physics.radius + 12, 30)
    }

    /// A canned reply with blocks, for screenshots: `BLOB_DEMO_REPLY=1`.
    private static var demoReply: String? {
        #if DEBUG
        guard ProcessInfo.processInfo.environment["BLOB_DEMO_REPLY"] != nil else { return nil }
        return """
        **Mostly refunds, after the payout delay.** 21 of 23 answered; two need you.

        ```metrics
        Tickets: 23 (+9)
        Answered: 21
        Median reply: 4 min (−2 min)
        ```

        ```csv
        Topic,Tickets
        Refunds,9
        Wallet pass,6
        Sign-in,5
        Other,3
        ```

        ```choices
        Show the two that need me
        Draft both replies
        ```
        """
        #else
        return nil
        #endif
    }

    private static var demoRunning: Bool {
        #if DEBUG
        BlobDemo.current != nil
        #else
        false
        #endif
    }

    /// Swipe up to look back. Over a long reply it counts only once the reply
    /// is scrolled to its end, so reading it never opens history by accident.
    private var historySwipe: some Gesture {
        DragGesture(minimumDistance: 24)
            .onChanged { _ in
                if dragStartedAtEnd == nil { dragStartedAtEnd = !replyOnScreen || replyAtEnd }
            }
            .onEnded { value in
                defer { dragStartedAtEnd = nil }
                let dy = value.translation.height
                guard !historyOpen, dragStartedAtEnd ?? true,
                      dy < -60, abs(value.translation.width) < -dy else { return }
                openHistory()
            }
    }

    private var replyOnScreen: Bool { text.replyEntry != nil || text.answer != nil || Self.demoReply != nil }

    private static func atEnd(_ geometry: ScrollGeometry) -> Bool {
        geometry.contentOffset.y + geometry.containerSize.height >= geometry.contentSize.height + geometry.contentInsets.bottom - 2
    }

    private func openHistory() {
        if typing && draft.isEmpty { typing = false }
        fieldFocused = false
        withAnimation(reduceMotion ? .easeOut(duration: 0.2) : .smooth(duration: 0.35)) { historyOpen = true }
    }

    private func closeHistory() {
        withAnimation(reduceMotion ? .easeOut(duration: 0.2) : .smooth(duration: 0.3)) { historyOpen = false }
    }

    /// History keeps clear of the safe area and of Blob: beside it when Blob
    /// sits in the Duo's system strip, above it in a phone's corner.
    private static func historyMargins(insets: EdgeInsets) -> EdgeInsets {
        let inStrip = insets.trailing >= 60 || insets.leading >= 60
        return EdgeInsets(
            top: max(insets.top, 20) + 16,
            leading: insets.leading + 24,
            bottom: inStrip ? max(insets.bottom, 20) + 16 : insets.bottom + 88,
            trailing: insets.trailing + 24
        )
    }

    private func toggleTalk() {
        if typing { typing = false; fieldFocused = false }
        // Blob may be reading a decision; talking cuts it off.
        if !text.active { text.speaker.stop() }
        if text.active || !usesVoice {
            hasTalked = true
            text.tap()
            return
        }
        if engine.active {
            engine.stop()
        } else {
            hasTalked = true
            Task { await engine.start() }
        }
    }

    /// The last line said, under Blob while you talk. Nothing at all when quiet,
    /// apart from a one-time hint and any reason a call failed.
    @ViewBuilder
    private func captions(insets: EdgeInsets) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            if text.active || Self.demoReply != nil {
                textCaptions
            } else if engine.active, let caption = engine.caption, !caption.text.isEmpty {
                Text(caption.text)
                    .font(caption.role == .assistant ? .title3 : .callout)
                    .foregroundStyle(caption.role == .assistant ? OS1VisualStyle.text : OS1VisualStyle.textFaint)
                    .frame(maxWidth: .infinity, alignment: caption.role == .assistant ? .leading : .trailing)
                    .multilineTextAlignment(caption.role == .assistant ? .leading : .trailing)
                    .lineLimit(4)
                    .transition(.opacity)
            } else if engine.state == .error, let message = engine.errorMessage {
                Text(message)
                    .font(.footnote)
                    .foregroundStyle(OS1VisualStyle.textDim)
            } else if let hint = engine.hint, engine.active {
                Text(hint)
                    .font(.footnote)
                    .foregroundStyle(OS1VisualStyle.textDim)
            } else if case .failed(let message) = text.phase, !usesVoice {
                Text(message)
                    .font(.footnote)
                    .foregroundStyle(OS1VisualStyle.textDim)
            } else if let said = decisionSaid {
                Text(said)
                    .font(.body)
                    .foregroundStyle(OS1VisualStyle.text)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .transition(.opacity)
            } else if let decision {
                BlobDecisionView(
                    item: decision,
                    position: decisions.position,
                    count: decisions.count,
                    sending: decisions.sending == decision.id,
                    // What the options and "Not now" take; the question gets the rest.
                    maxHeight: max(160, replyHeight - CGFloat(decision.options.count) * 56 - 44),
                    answer: { option in Task { await decisions.answer(decision, with: option) } },
                    notNow: { decisions.skip(decision) },
                    dismiss: { Task { await decisions.dismiss(decision) } }
                )
                .id(decision.id)
                .transition(reduceMotion ? .opacity : .offset(y: 16).combined(with: .opacity))
            } else if !hasTalked && !talking && !typing && !Self.demoRunning {
                Text(Self.talkHint)
                    .font(.footnote)
                    .foregroundStyle(OS1VisualStyle.textFaint)
                    .frame(maxWidth: .infinity, alignment: .trailing)
            }
        }
        .padding(.leading, insets.leading + 24)
        .padding(.trailing, insets.trailing + 24)
        .padding(.bottom, max(insets.bottom, 20) + (typing ? 76 : talking ? 28 : 60))
        .animation(.easeOut(duration: 0.24), value: engine.caption?.text)
        .allowsHitTesting(text.answer != nil || decision != nil)
    }

    /// Writing instead of speaking: a small keyboard button while Blob is
    /// quiet, a one-line field while you type. Return sends.
    @ViewBuilder
    private var writeBar: some View {
        if typing {
            HStack(spacing: 8) {
                TextField("Write to Blob", text: $draft, axis: .vertical)
                    .textFieldStyle(.plain)
                    .lineLimit(1...4)
                    .focused($fieldFocused)
                    .submitLabel(.send)
                    .onSubmit(sendDraft)
                    .padding(.horizontal, 16)
                    .padding(.vertical, 12)
                    .background(Capsule().fill(OS1VisualStyle.hover))
                Button(action: sendDraft) {
                    Image(systemName: "arrow.up")
                        .font(.system(size: 16, weight: .semibold))
                        .foregroundStyle(.white)
                        .frame(width: 40, height: 40)
                        .background(Circle().fill(draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? AnyShapeStyle(OS1VisualStyle.textFaint) : AnyShapeStyle(OS1VisualStyle.accentInk)))
                }
                .buttonStyle(.plain)
                .disabled(draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                .accessibilityLabel("Send")
            }
            .padding(.horizontal, 16)
            .padding(.bottom, 10)
            .transition(.move(edge: .bottom).combined(with: .opacity))
        } else if !engine.active && text.phase != .listening && !historyOpen {
            HStack {
                Button(action: startWriting) {
                    Image(systemName: "keyboard")
                        .font(.system(size: 17, weight: .regular))
                        .foregroundStyle(OS1VisualStyle.textDim)
                        .frame(width: 44, height: 44)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Write instead")
                Spacer()
            }
            .padding(.leading, 14)
            .padding(.bottom, 4)
        }
    }

    private func sendDraft() {
        let message = draft
        guard !message.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return }
        draft = ""
        hasTalked = true
        // The field stays open, so the next line is one tap away.
        text.send(typed: message)
    }

    /// Text mode: what you said, then Blob's answer. A long answer scrolls.
    @ViewBuilder
    private var textCaptions: some View {
        if !text.heard.isEmpty {
            Text(text.heard)
                .font(.callout)
                .foregroundStyle(OS1VisualStyle.textFaint)
                .frame(maxWidth: .infinity, alignment: .trailing)
                .multilineTextAlignment(.trailing)
                .lineLimit(3)
        } else if text.listener.preparing {
            Text("Getting my ears ready\u{2026}")
                .font(.footnote)
                .foregroundStyle(OS1VisualStyle.textFaint)
                .frame(maxWidth: .infinity, alignment: .trailing)
        } else if text.phase == .listening {
            Text("Listening\u{2026} tap me when you\u{2019}re done")
                .font(.footnote)
                .foregroundStyle(OS1VisualStyle.textFaint)
                .frame(maxWidth: .infinity, alignment: .trailing)
        }
        if let content = Self.demoReply ?? text.replyEntry?.content, !content.isEmpty {
            // The finished reply: what Blob says, then what it shows, drawn
            // with the block catalog as in the OS app.
            ScrollView {
                BlobReplyView(reply: BlobReply(content), entryId: text.replyEntry?.id, relay: text.relay)
            }
            .frame(maxHeight: replyHeight)
            .scrollBounceBehavior(.basedOnSize)
            .onScrollGeometryChange(for: Bool.self, of: Self.atEnd) { _, atEnd in replyAtEnd = atEnd }
        } else if let answer = text.answer {
            // Still being written: plain text until the reply settles.
            ScrollView {
                BlobReplyView(reply: BlobReply(answer), streaming: true)
            }
            .frame(maxHeight: replyHeight)
            .scrollBounceBehavior(.basedOnSize)
        }
    }
}

#if DEBUG
/// A scripted conversation for screenshots and motion checks without a server
/// or a microphone: launch with `BLOB_DEMO=1`. `BLOB_DEMO_AT=<seconds>` freezes
/// it at one moment.
enum BlobDemo {
    struct Frame { var mode: BlobMode; var talking: Bool; var level: Double }

    private static let env = ProcessInfo.processInfo.environment
    private static let enabled = env["BLOB_DEMO"] != nil
    private static let frozen = env["BLOB_DEMO_AT"].flatMap(Double.init)
    private static let start = Date()

    static var current: Frame? { at(Date()) }

    static func at(_ date: Date) -> Frame? {
        guard enabled else { return nil }
        let t = frozen ?? date.timeIntervalSince(start).truncatingRemainder(dividingBy: 12)
        let wave = 0.5 + 0.35 * sin(t * 11) * sin(t * 3.7) + 0.15 * sin(t * 23)
        switch t {
        case ..<2: return Frame(mode: .quiet, talking: false, level: 0)
        case ..<3: return Frame(mode: .think, talking: true, level: 0)
        case ..<6: return Frame(mode: .listen, talking: true, level: wave)
        case ..<6.6: return Frame(mode: .think, talking: true, level: 0)
        case ..<10: return Frame(mode: .speak, talking: true, level: wave)
        default: return Frame(mode: .quiet, talking: false, level: 0)
        }
    }
}
#endif

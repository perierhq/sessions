import SwiftUI

/// Blob's home: an empty screen with Blob asleep in its slot. Tap it to talk;
/// it moves to the middle, listens and answers through the Desk's live voice
/// call, then goes back to its slot when you tap it again.
///
/// Talking is a tap, not hold-to-talk: the live call takes a few seconds to
/// connect, and holding would cut off the first words of every sentence.
struct BlobHomeView: View {
    private let engine = DeskVoiceEngine.desk
    /// Used instead of the voice call when the server has no voice key.
    @State private var text = BlobTextTalk()
    /// Nil until the server answers; voice stays the default when it can't say.
    @State private var voiceConfigured: Bool?
    @State private var physics = BlobPhysics()
    /// Room a reply may take: the screen below Blob, minus what you said.
    @State private var replyHeight: CGFloat = 420
    @State private var showSettings = false
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
                TimelineView(.animation(paused: scenePhase != .active)) { timeline in
                    let targets = targets(in: geo.size, insets: insets, at: timeline.date)
                    Canvas { context, _ in
                        physics.advance(to: timeline.date, targets: targets)
                        physics.draw(in: &context, dark: colorScheme == .dark, reduceMotion: reduceMotion)
                    }
                }
                .accessibilityElement()
                .accessibilityLabel("Blob")
                .accessibilityValue(talking ? statusLabel : "Asleep")
                .accessibilityHint(talking ? "Ends the conversation" : "Starts a conversation")
                .accessibilityAddTraits(.isButton)
                .accessibilityAction { toggleTalk() }

                captions(insets: insets)
            }
            .contentShape(Rectangle())
            .onTapGesture(coordinateSpace: .local) { location in
                if hit(location) { toggleTalk() }
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
        .background(OS1VisualStyle.background.ignoresSafeArea())
        .sheet(isPresented: $showSettings) { BlobSettingsView(speaker: text.speaker) }
        .onChange(of: text.listener.text) { _, _ in text.syncHeard() }
        .onChange(of: text.settled) { _, settled in if settled { text.answerSettled() } }
        .task { voiceConfigured = await BlobTextTalk.voiceConfigured() }
        .onChange(of: scenePhase) { _, phase in
            // A backgrounded app must never hold the mic open.
            if phase == .background {
                if !engine.shownOutsideApp { engine.stop() }
                text.reset()
            }
        }
    }

    /// The live voice call, unless the server says it has no voice key.
    private var usesVoice: Bool { voiceConfigured != false }
    private var talking: Bool { usesVoice ? engine.active : text.active }

    private var statusLabel: String {
        if usesVoice { return engine.state.label }
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
        if !usesVoice {
            // No voice key: Blob listens through dictation and answers in text,
            // so "speaking" is a smile with no voice pulse.
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
        var talking = talking, mode = mode, level = usesVoice ? Double(engine.audioLevel) : text.level(at: date)
        #if DEBUG
        if let demo = BlobDemo.at(date) { talking = demo.talking; mode = demo.mode; level = demo.level }
        #endif
        // A reply on screen gets the room: Blob moves up and keeps talking from there.
        let showingReply = (!usesVoice && text.answer != nil) || Self.demoReply != nil
        let top = CGPoint(x: center.x, y: max(insets.top, 20) + 56)
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

    private func toggleTalk() {
        if !usesVoice {
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
            if (!usesVoice && text.active) || Self.demoReply != nil {
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
            } else if !hasTalked && !talking && !Self.demoRunning {
                Text("Tap me to talk")
                    .font(.footnote)
                    .foregroundStyle(OS1VisualStyle.textFaint)
                    .frame(maxWidth: .infinity, alignment: .trailing)
            }
        }
        .padding(.leading, insets.leading + 24)
        .padding(.trailing, insets.trailing + 24)
        .padding(.bottom, max(insets.bottom, 20) + (talking ? 28 : 60))
        .animation(.easeOut(duration: 0.24), value: engine.caption?.text)
        .allowsHitTesting(!usesVoice && text.answer != nil)
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
            // The finished reply, drawn with the block catalog: metrics, charts,
            // tables, choices and the rest render as they do in the OS app.
            ScrollView {
                MarkdownBody(content)
                    .environment(\.quickReplyRelay, text.relay)
                    .environment(\.transcriptEntryId, text.replyEntry?.id)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            .frame(maxHeight: replyHeight)
            .scrollBounceBehavior(.basedOnSize)
        } else if let answer = text.answer {
            // Still being written: plain text until the reply settles.
            ScrollView {
                Text(answer)
                    .font(.body)
                    .foregroundStyle(OS1VisualStyle.text)
                    .frame(maxWidth: .infinity, alignment: .leading)
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

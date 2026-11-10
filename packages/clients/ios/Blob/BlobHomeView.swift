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
    @State private var showSettings = false
    /// Writing instead of speaking.
    @State private var typing = false
    @State private var draft = ""
    /// Earlier exchanges sit above the current one on the page, but only
    /// after you pull past its top (or drag on the empty home) and let go.
    @State private var historyRevealed = false
    /// The page's scroll, for the pull that reveals history and for Latest.
    @State private var metrics = PageMetrics()
    @State private var scrollPhase: ScrollPhase = .idle
    /// Pulled far enough that letting go reveals history.
    @State private var armed = false
    /// Where the current exchange starts, in the page's content.
    @State private var nowY: CGFloat = 0
    @State private var latestTaps = 0
    @FocusState private var fieldFocused: Bool
    #if DEBUG
    /// `BLOB_DEMO_REPLY=cycle`: which of its two replies is up.
    @State private var demoFlip = false
    #endif
    @AppStorage("blob.hasTalked") private var hasTalked = false
    @AppStorage(BlobSpeaker.readAloudKey) private var readAloud = true
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.scenePhase) private var scenePhase

    var body: some View {
        // The outer reader only measures the safe area; the inner one draws
        // full bleed so Blob can sit in the Duo's system strip.
        GeometryReader { outer in
            let insets = outer.safeAreaInsets
            GeometryReader { geo in
            let panes = BlobPanes.layout(in: geo)
            let columns = BlobColumns(width: geo.size.width, insets: insets, panes: panes)
            // The settled reply has a second pane: beside it while history
            // is closed, in the page's two columns while it is open.
            let split = panes != nil && sideBeside
            let side = split && !historyRevealed
            let talkCenter = CGPoint(x: columns.centered.midX, y: geo.size.height * 0.4)
            ZStack(alignment: .bottom) {
                // One page across the surface. Its column is centered until
                // the reply has something for a second pane; then the
                // conversation moves to the leading pane and the reply's
                // visuals come in on the trailing one, nothing on the fold.
                page(insets: insets, columns: columns, split: split)

                ZStack {
                    if let panes, side {
                        sidePane(insets: insets)
                            .frame(width: panes.trailingWidth)
                            .frame(maxWidth: .infinity, alignment: .trailing)
                            .transition(reduceMotion ? .opacity : .offset(x: 40).combined(with: .opacity))
                    }
                }
                .animation(reduceMotion ? .easeOut(duration: 0.2) : Self.paneSpring, value: side)

                // Drawn over the page, so Blob stays visible in its slot, but
                // never in the way of a scroll: taps are handled below.
                TimelineView(.animation(paused: scenePhase != .active)) { timeline in
                    let targets = targets(in: geo.size, insets: insets, center: talkCenter, at: timeline.date)
                    Canvas { context, _ in
                        physics.advance(to: timeline.date, targets: targets)
                        physics.draw(in: &context, dark: colorScheme == .dark, reduceMotion: reduceMotion)
                    }
                }
                .allowsHitTesting(false)
                .accessibilityElement()
                .accessibilityLabel("Blob")
                .accessibilityValue(historyRevealed ? "History" : talking ? statusLabel : needsYou ? "Needs you" : "Asleep")
                .accessibilityHint(historyRevealed ? "Goes back to the latest" : talking ? "Ends the conversation" : "Starts a conversation")
                .accessibilityAddTraits(.isButton)
                .accessibilityAction { blobTapped() }
                .accessibilityAction(named: historyRevealed ? "Back to latest" : "Show history") {
                    historyRevealed ? collapseHistory() : revealHistory()
                }

                // What the supervisor is doing, as a thought beside Blob's
                // head while it thinks, inside the safe area and on Blob's
                // side of a fold.
                BlobThinkingLayer(
                    talk: text,
                    physics: physics,
                    bounds: CGRect(
                        x: insets.leading + 12,
                        y: max(insets.top, 20) + 8,
                        width: max(0, geo.size.width - insets.leading - insets.trailing - 24),
                        height: max(0, geo.size.height - max(insets.top, 20) - max(insets.bottom, 20) - 96)
                    ),
                    fold: panes?.physical == true ? panes?.fold : nil,
                    hidden: historyRevealed
                )

                if !hasContent && !historyRevealed {
                    captions(insets: insets, column: columns.centered)
                        .transition(.opacity)
                }

                if showsLatest {
                    latestButton(insets: insets, column: side ? columns.leading ?? columns.centered : columns.centered)
                }
            }
            .contentShape(Rectangle())
            .onTapGesture(coordinateSpace: .local) { location in
                if hit(location) {
                    blobTapped()
                } else if typing && draft.isEmpty {
                    typing = false
                    fieldFocused = false
                }
            }
            .onLongPressGesture { showSettings = true }
            .onAppear { BlobSurfaceReport.update(size: geo.size, panes: panes == nil ? 1 : 2) }
            .onChange(of: panes) { _, panes in BlobSurfaceReport.update(size: geo.size, panes: panes == nil ? 1 : 2) }
            // History lays this exchange out the way it is shown now.
            .onChange(of: split ? text.currentExchangeId : nil, initial: true) { _, id in
                if let id { text.markShownBeside(id) }
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
        .onChange(of: text.acceptedEntry?.id) { _, _ in text.accepted() }
        .onChange(of: text.streamingText) { _, _ in text.answerStreamed() }
        .onChange(of: text.settled) { _, settled in if settled { text.answerSettled() } }
        .animation(reduceMotion ? nil : .easeOut(duration: 0.2), value: typing)
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
        // The reply to your message wins: while one is on its way or being
        // read, decisions stay silent.
        .onChange(of: decision?.id, initial: true) { old, new in
            guard !text.replyHasVoice else { return }
            if old != nil, old != new { text.hush() }
            if let decision, decisions.shouldSpeak(decision) {
                let say = BlobReply(decision.body).spoken
                if !say.isEmpty { text.speaker.speak(say) }
            }
        }
        // Blob reads what the run asks you when it comes up, once; during
        // the live voice call it waits until the call ends.
        .onChange(of: ask?.id, initial: true) { _, _ in
            if let ask { text.askCameUp(ask, callActive: engine.active) }
        }
        .onChange(of: engine.active) { _, active in
            if !active, let ask { text.askCameUp(ask, callActive: false) }
        }
        // A Bark notification's link: `blob://item/<id>` shows that item as
        // the current decision; `blob://` alone just opens Blob.
        .onOpenURL { url in
            guard let id = BlobLink.itemId(url) else { return }
            if historyRevealed { collapseHistory() }
            if typing && draft.isEmpty { typing = false; fieldFocused = false }
            if text.phase != .listening { text.reset() }
            Task { await decisions.focus(id: id) }
        }
        .animation(reduceMotion ? .easeOut(duration: 0.2) : .smooth(duration: 0.35), value: decisionKey)
        .animation(reduceMotion ? .easeOut(duration: 0.2) : .smooth(duration: 0.35), value: ask?.id)
        #if DEBUG
        .onAppear {
            if ProcessInfo.processInfo.environment["BLOB_DEMO_TYPING"] != nil {
                draft = "what shipped this week?"
                typing = true
            }
            if BlobExchange.demoReveal != nil { revealHistory() }
        }
        .task {
            guard ProcessInfo.processInfo.environment["BLOB_DEMO_REPLY"] == "cycle" else { return }
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(4))
                demoFlip.toggle()
            }
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
            case .history: historyRevealed ? collapseHistory() : revealHistory()
            case .settings: showSettings = true
            }
        }
        #endif
        .onChange(of: scenePhase) { _, phase in
            // A backgrounded app must never hold the mic open.
            if phase == .background {
                if !engine.shownOutsideApp { engine.stop() }
                text.pause()
                BlobMetrics.shared.background()
                BlobParakeet.shared.unload()
            } else if phase == .active, BlobTranscriber.current == .parakeet {
                BlobParakeet.shared.warm()
            }
        }
    }

    #if os(macOS)
    /// One line for the menu bar item.
    private var menuStatus: String {
        if talking { return statusLabel.isEmpty ? "Talking" : statusLabel }
        return needsYou ? "Needs you" : "Asleep"
    }

    /// Space talks, or stops talking.
    private func spaceKey() -> Bool {
        toggleTalk()
        return true
    }

    /// Esc stops Blob reading, then hides history, then closes the write bar.
    private func escapeKey() -> Bool {
        if text.reading {
            text.hush()
        } else if historyRevealed {
            collapseHistory()
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
        typing = true
        fieldFocused = true
    }

    /// The live voice call: only when turned on in settings and the server
    /// has a voice key.
    private var usesVoice: Bool { liveCall && voiceConfigured != false }
    /// Typed messages, and speech without a voice key, go through `text`.
    private var talking: Bool { engine.active || text.active }
    private var textConversation: Bool { text.active || !usesVoice }

    /// Nothing else going on: no conversation, no typing, no reply on
    /// screen. Only then does a decision come up.
    private var idle: Bool {
        !talking && !typing && !replyOnScreen && ask == nil && !Self.demoRunning
    }

    /// What the supervisor's run is waiting on you for, shown where replies
    /// render. It comes before decisions and replies: until it is answered
    /// the run does nothing else.
    private var ask: BlobAsk? { text.ask }

    /// Blob is awake because something needs you.
    private var needsYou: Bool { showingDecision || ask != nil }

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
        case .waiting: return ask != nil ? "Needs you" : text.thinking ? "Thinking" : "Answering"
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
            case .waiting: return ask != nil ? .you : text.thinking ? .think : .speak
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
    /// `center` is where it talks: the middle of the page's centered column.
    private func targets(in size: CGSize, insets: EdgeInsets, center: CGPoint, at date: Date) -> BlobTargets {
        let slot = Self.slot(in: size, insets: insets)
        var talking = talking, mode = mode, level = textConversation ? text.level(at: date) : Double(engine.audioLevel)
        #if DEBUG
        if let demo = BlobDemo.at(date) { talking = demo.talking; mode = demo.mode; level = demo.level }
        #endif
        // Content on the page gets the screen: Blob stays small in its slot
        // and keeps talking from there. So does history.
        let docked = hasContent || historyRevealed
        if historyRevealed { talking = false }
        // Something needs you: Blob wakes in its slot.
        if !talking && needsYou {
            let reading = text.speaker.speaking
            return BlobTargets(
                mode: decisionSaid != nil || reading ? .speak : .you,
                position: slot,
                size: 48,
                look: nil,
                level: reading ? text.speaker.level(at: date) : 0
            )
        }
        return BlobTargets(
            mode: mode,
            position: talking && !docked ? center : slot,
            size: talking && !docked ? 132 : 48,
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

    /// A canned reply with blocks, for screenshots: `BLOB_DEMO_REPLY=1`,
    /// `long` for one taller than the screen, `plain` for one with no
    /// visual blocks, or `cycle` to add and take away the blocks reply's
    /// visuals every 4 s, for the move between one pane and two.
    /// `BLOB_DEMO_SCROLL=end` starts the page scrolled to its end.
    private var demoReply: String? {
        #if DEBUG
        switch ProcessInfo.processInfo.environment["BLOB_DEMO_REPLY"] {
        case nil: return nil
        case "long": return Self.demoLongReply
        case "plain":
            return "On it. I'll start the wallet pass review now and tell you when it's done.\n\n```choices\nThanks\nSkip the tests\n```"
        case "cycle": return demoFlip ? Self.demoBlocksReply : BlobReplySplit(Self.demoBlocksReply).conversation
        default: return Self.demoBlocksReply
        }
        #else
        return nil
        #endif
    }

    #if DEBUG
    private static let demoBlocksReply = """
    ```say
    [warm, unhurried] It was mostly refunds after the payout delay. {#stats} Nearly all of them are answered, {#topics} and two still need you.
    ```

    ```metrics {#stats}
    Tickets: 23 (+9)
    Answered: 21
    Median reply: 4 min (−2 min)
    ```

    ```csv {#topics}
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
    #endif

    #if DEBUG
    private static let demoLongReply = """
    **The payout fix is live, and two refund tickets need your call.** Everything else from overnight is handled.

    ### Overnight
    - The payout delay fix merged at 02:10 and deployed at 02:22.
    - 14 delayed payouts went out; the oldest was three days late.
    - No new payout errors since the deploy.

    ```metrics
    Payouts sent: 14
    Errors since deploy: 0
    Tickets: 23 (+9)
    ```

    ### Support
    Most tickets were about refunds after the delay. I answered 21 of 23 with the refund note and a link to the payout status page.

    ```csv
    Topic,Tickets
    Refunds,9
    Wallet pass,6
    Sign-in,5
    Other,3
    ```

    ### Needs you
    1. A customer wants a refund on a payout that already arrived.
    2. A partner wants the delay explained in writing before Friday.

    I drafted replies for both. They're waiting in Plain.

    ```choices
    Send both drafts
    Show me the drafts
    Wait until tomorrow
    ```
    """
    #endif

    private static var demoRunning: Bool {
        #if DEBUG
        BlobDemo.current != nil
        #else
        false
        #endif
    }

    private var replyOnScreen: Bool { text.replyEntry != nil || text.answer != nil || demoReply != nil }

    /// Something to read on the page: a reply, a question from the run, or a
    /// decision. It starts at the top, Blob docks in its slot, and its
    /// actions follow it inline.
    private var hasContent: Bool { replyOnScreen || ask != nil || showingDecision }

    /// Changes when a new item takes the page: a message sent, a question
    /// asked, the next decision. History folds away and the page goes to
    /// the new item's top.
    private var turnKey: String { "\(text.sends)|\(ask?.id ?? "")|\(decision?.id ?? "")" }

    /// How far past an edge a pull must go before letting go reveals history.
    private static let pullToReveal: CGFloat = 64

    private func revealHistory() {
        guard !historyRevealed else { return }
        if typing && draft.isEmpty { typing = false }
        fieldFocused = false
        historyRevealed = true
    }

    private func collapseHistory() {
        withAnimation(reduceMotion ? .easeOut(duration: 0.2) : .smooth(duration: 0.3)) { historyRevealed = false }
    }

    /// Tapping Blob goes back to the quiet home from history (and lets the
    /// reply on screen go); otherwise it talks.
    private func blobTapped() {
        if historyRevealed {
            collapseHistory()
            if text.phase == .waiting { text.reset() }
        } else {
            toggleTalk()
        }
    }

    /// The page keeps clear of the safe area and of Blob: beside it when Blob
    /// sits in the Duo's system strip, above it in a phone's corner. The
    /// bottom clears the keyboard button and the write bar, so the end of a
    /// reply and its actions are never covered.
    /// Across the page, the columns (`BlobColumns`) keep clear of the sides;
    /// beside a fold the leading pane ends at the fold's region, which
    /// already carries its margins.
    private static func pageMargins(insets: EdgeInsets, typing: Bool) -> EdgeInsets {
        EdgeInsets(
            top: max(insets.top, 20) + 16,
            leading: 0,
            bottom: max(insets.bottom, 20) + (typing ? 84 : 68),
            trailing: 0
        )
    }

    /// The conversation moving between centered and the leading pane, and
    /// the visuals coming in beside it: a spring, so a reply that lands
    /// mid-move carries on from where it is.
    static let paneSpring = Animation.spring(duration: 0.5, bounce: 0)

    /// The current reply's visual blocks, for the second pane.
    private var currentVisuals: [String] {
        settledReply.map { BlobReplySplit($0).visuals } ?? []
    }

    /// A decision waiting beside the settled reply, for the second pane
    /// when the reply has no visuals of its own.
    private var decisionBeside: OS1API.SupervisorItem? {
        guard settledReply != nil, decisions.said == nil else { return nil }
        return decisions.current
    }

    /// The settled reply has something for a second pane on a wide surface.
    private var sideBeside: Bool { !currentVisuals.isEmpty || decisionBeside != nil }

    /// The settled reply on the page, if there is one: the demo's or the
    /// run's. Nil while it streams and while a question is up.
    private var settledReply: String? {
        guard ask == nil, let content = demoReply ?? text.replyEntry?.content, !content.isEmpty else { return nil }
        return content
    }

    /// The trailing pane: the current reply's visual blocks; without any,
    /// the decision waiting on you, or nothing.
    private func sidePane(insets: EdgeInsets) -> some View {
        BlobSidePane(
            visuals: currentVisuals,
            focus: text.focus,
            margins: EdgeInsets(
                top: max(insets.top, 20) + 16,
                leading: 0,
                bottom: max(insets.bottom, 20) + 68,
                trailing: insets.trailing + 24
            )
        ) {
            decisionBesideView
        }
        .id(turnKey)
    }

    /// The decision waiting beside the settled reply, in the second pane.
    /// Only beside a reply: a decision that is itself the current item
    /// stays with the conversation.
    @ViewBuilder
    private var decisionBesideView: some View {
        if let waiting = decisionBeside {
            BlobDecisionView(
                item: waiting,
                position: decisions.position,
                count: decisions.count,
                sending: decisions.sending == waiting.id,
                answer: { option in Task { await decisions.answer(waiting, with: option) } },
                notNow: { decisions.skip(waiting) },
                dismiss: { Task { await decisions.dismiss(waiting) } }
            )
            .id(waiting.id)
        }
    }

    /// Where the current exchange's top sits when the page goes to it: just
    /// under the top margin.
    private func nowAnchor(_ margins: EdgeInsets) -> UnitPoint {
        UnitPoint(x: 0.5, y: metrics.container > 0 ? margins.top / metrics.container : 0)
    }

    /// Scrolled up into history, far enough that the latest is off screen.
    private var showsLatest: Bool {
        guard historyRevealed, metrics.container > 0 else { return false }
        if hasContent { return nowY - metrics.offset > metrics.container * 0.85 }
        return metrics.content - metrics.offset > metrics.container + 160
    }

    /// The whole home is one page: earlier exchanges (once revealed), then
    /// the current one, which starts at the top and scrolls in full, its
    /// actions inline after it. Nothing scrolls inside it.
    /// `split`: the current reply has a second pane (its visuals, or a
    /// decision waiting beside it). With history closed that is the
    /// trailing pane (`sidePane`) and the conversation takes the leading
    /// one; with history open both scroll with the page instead, in the
    /// same two columns (`BlobSplitRow`).
    private func page(insets: EdgeInsets, columns: BlobColumns, split: Bool) -> some View {
        let margins = Self.pageMargins(insets: insets, typing: typing)
        let side = split && !historyRevealed
        let inline = split && historyRevealed
        return ScrollViewReader { proxy in
            ScrollView {
                VStack(spacing: 0) {
                    // Not lazy: the page goes to the current exchange's start
                    // by id and tracks where it is, wherever it scrolled.
                    VStack(alignment: .leading, spacing: 0) {
                        if historyRevealed { historyRows(columns) }
                        Color.clear
                            .frame(height: 0)
                            .id(PageMark.now)
                            .onGeometryChange(for: CGFloat.self) { $0.frame(in: .named(PageMark.space)).minY } action: { nowY = $0 }
                        if hasContent {
                            Group {
                                if inline {
                                    BlobSplitRow(columns: columns, visuals: currentVisuals) {
                                        current(split: true)
                                    } beside: {
                                        if currentVisuals.isEmpty { decisionBesideView }
                                    }
                                } else {
                                    current(split: split)
                                        .blobColumn(side ? columns.leading ?? columns.centered : columns.centered)
                                        .animation(reduceMotion ? nil : Self.paneSpring, value: side)
                                }
                            }
                            .padding(.top, historyRevealed ? 8 : 0)
                            .id(PageMark.current)
                        }
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(margins)
                    Color.clear.frame(height: 0).id(PageMark.end)
                }
                .coordinateSpace(.named(PageMark.space))
            }
            .defaultScrollAnchor(.top, for: .initialOffset)
            // Older pages arrive above what you're reading; keep it in place.
            // Without history the current reply grows downward from its top.
            .defaultScrollAnchor(historyRevealed ? .bottom : .top, for: .sizeChanges)
            .scrollBounceBehavior(.always)
            .scrollIndicators(.hidden)
            // Content fades out at the edges instead of being cut off, and
            // before it passes under the keyboard button and Blob.
            .mask {
                VStack(spacing: 0) {
                    LinearGradient(colors: [.clear, .black], startPoint: .top, endPoint: .bottom)
                        .frame(height: margins.top)
                    Rectangle()
                    LinearGradient(colors: [.black, .clear], startPoint: .top, endPoint: .bottom)
                        .frame(height: 24)
                    Color.clear
                        .frame(height: max(0, margins.bottom - 24))
                }
                .ignoresSafeArea()
            }
            .onScrollPhaseChange { _, phase in
                scrollPhase = phase
                if phase != .interacting, armed {
                    armed = false
                    revealHistory()
                }
            }
            .onScrollGeometryChange(for: PageMetrics.self) { geometry in
                PageMetrics(
                    offset: geometry.contentOffset.y + geometry.contentInsets.top,
                    container: geometry.containerSize.height,
                    content: geometry.contentSize.height
                )
            } action: { _, next in
                metrics = next
                // Near the oldest exchange: the page before it loads above,
                // and the bottom anchor keeps what you're reading in place.
                if historyRevealed, next.offset < next.container, text.canLoadEarlier, !text.loadingEarlier {
                    text.loadEarlier()
                }
                // Only a pull you are still holding arms it, never a flick's
                // momentum bouncing off the top.
                guard !historyRevealed, scrollPhase == .interacting else { return }
                let fits = next.content <= next.container
                let pulled = -next.offset > Self.pullToReveal || (!hasContent && fits && next.offset > Self.pullToReveal)
                if pulled != armed { armed = pulled }
            }
            .sensoryFeedback(.impact(weight: .light), trigger: armed) { _, now in now }
            .overlay(alignment: .top) { pullHint(insets: insets).blobColumn(columns.centered) }
            .onChange(of: historyRevealed) { _, revealed in
                Task { @MainActor in
                    withAnimation(reduceMotion ? .easeOut(duration: 0.2) : .smooth(duration: 0.35)) {
                        if !revealed {
                            proxy.scrollTo(PageMark.now, anchor: nowAnchor(margins))
                        } else if hasContent {
                            // The latest earlier exchange comes into view above
                            // the current one, which slides down to make room.
                            proxy.scrollTo(PageMark.now, anchor: UnitPoint(x: 0.5, y: 0.55))
                        } else {
                            proxy.scrollTo(PageMark.end, anchor: .bottom)
                        }
                    }
                }
            }
            .onChange(of: text.focus) { _, focus in follow(focus, in: pageReply(split: split), with: proxy) }
            .onChange(of: latestTaps) { _, _ in
                withAnimation(reduceMotion ? .easeOut(duration: 0.2) : .smooth(duration: 0.35)) {
                    if hasContent {
                        proxy.scrollTo(PageMark.now, anchor: nowAnchor(margins))
                    } else {
                        proxy.scrollTo(PageMark.end, anchor: .bottom)
                    }
                }
            }
            .onChange(of: turnKey) { _, _ in
                if historyRevealed {
                    collapseHistory()
                } else {
                    proxy.scrollTo(PageMark.now, anchor: nowAnchor(margins))
                }
            }
            #if DEBUG
            .task {
                let env = ProcessInfo.processInfo.environment
                try? await Task.sleep(for: .seconds(3))
                if env["BLOB_DEMO_SCROLL"] == "end" { proxy.scrollTo(PageMark.end, anchor: .bottom) }
                if BlobExchange.demoReveal == "top", let first = text.earlier.first {
                    proxy.scrollTo(first.id, anchor: nowAnchor(margins))
                }
            }
            #endif
        }
    }

    /// Earlier exchanges, oldest first, without their quick replies.
    @ViewBuilder
    private func historyRows(_ columns: BlobColumns) -> some View {
        let exchanges = text.earlier
        if text.loadingEarlier {
            ProgressView()
                .frame(maxWidth: .infinity)
                .blobColumn(columns.centered)
                .padding(.bottom, 24)
        } else if exchanges.isEmpty {
            Text("Nothing yet")
                .font(.caption2)
                .foregroundStyle(OS1VisualStyle.textDim)
                .frame(maxWidth: .infinity)
                .blobColumn(columns.centered)
                .padding(.bottom, 32)
        }
        ForEach(Array(exchanges.enumerated()), id: \.element.id) { index, exchange in
            BlobHistoryRow(exchange: exchange, day: BlobHistoryRow.header(exchanges, at: index), first: index == 0, columns: columns)
                .id(exchange.id)
        }
    }

    /// Over the gap a pull opens above the page: says that letting go shows
    /// what came before.
    @ViewBuilder
    private func pullHint(insets: EdgeInsets) -> some View {
        let pull = max(0, -metrics.offset)
        if !historyRevealed, pull > 12, scrollPhase == .interacting {
            Text(armed ? "Release for earlier" : "Earlier")
                .font(.caption2)
                .foregroundStyle(OS1VisualStyle.textDim)
                .opacity(min(1, pull / Self.pullToReveal))
                .offset(y: max(insets.top, 12) + pull / 2 - 6)
                .allowsHitTesting(false)
                .accessibilityHidden(true)
        }
    }

    /// Back to the current exchange, or the newest one on the quiet home.
    private func latestButton(insets: EdgeInsets, column: BlobColumns.Span) -> some View {
        Button { latestTaps += 1 } label: {
            Label("Latest", systemImage: "arrow.down")
                .font(.footnote.weight(.medium))
        }
        .buttonStyle(.glass)
        .frame(maxWidth: .infinity)
        .blobColumn(column)
        .padding(.bottom, insets.bottom + (typing ? 72 : 8))
        .transition(reduceMotion ? .opacity : .opacity.combined(with: .scale(scale: 0.95)))
    }

    private func toggleTalk() {
        if historyRevealed { collapseHistory() }
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
    /// apart from a one-time hint and any reason a call failed. What is read
    /// (replies, questions, decisions) goes on the page instead.
    @ViewBuilder
    private func captions(insets: EdgeInsets, column: BlobColumns.Span) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            if text.active {
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
            } else if !hasTalked && !talking && !typing && !Self.demoRunning {
                Text(Self.talkHint)
                    .font(.footnote)
                    .foregroundStyle(OS1VisualStyle.textFaint)
                    .frame(maxWidth: .infinity, alignment: .trailing)
            }
        }
        .blobColumn(column)
        .padding(.bottom, max(insets.bottom, 20) + (typing ? 76 : talking ? 28 : 60))
        .animation(.easeOut(duration: 0.24), value: engine.caption?.text)
        .allowsHitTesting(false)
    }

    /// Writing instead of speaking: a small keyboard button while Blob is
    /// quiet, a one-line field while you type. Return sends.
    /// The page keeps room for it at the bottom, so it covers nothing.
    @ViewBuilder
    private var writeBar: some View {
        if typing {
            HStack(spacing: 8) {
                TextField(ask?.takesText == true ? "Answer Blob" : "Write to Blob", text: $draft, axis: .vertical)
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
        } else if !engine.active && text.phase != .listening {
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
        if let ask, ask.takesText {
            // A question is waiting: what you write answers it.
            Task { try? await text.answer(ask, with: .answer(message.trimmingCharacters(in: .whitespacesAndNewlines))) }
        } else {
            text.send(typed: message)
        }
    }

    /// What the run asks, where replies render.
    private func askView(_ ask: BlobAsk) -> some View {
        BlobAskView(
            ask: ask,
            answer: { action in try await text.answer(ask, with: action) },
            write: startWriting
        )
        .id(ask.id)
        .transition(reduceMotion ? .opacity : .offset(y: 16).combined(with: .opacity))
    }

    /// Text mode before there is anything to read: what you are saying.
    /// That Blob is working on it is its thought (`BlobThinkingLayer`).
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
            Text(text.listener.endsByItself ? "Listening\u{2026}" : "Listening\u{2026} tap when you\u{2019}re done")
                .font(.footnote)
                .foregroundStyle(OS1VisualStyle.textFaint)
                .frame(maxWidth: .infinity, alignment: .trailing)
        }
        if let notice = text.notice {
            noticeLine(notice)
        }
    }

    /// An answered ask that didn't go through, like a refused merge.
    private func noticeLine(_ notice: String) -> some View {
        Text(notice)
            .font(.footnote)
            .foregroundStyle(OS1VisualStyle.textDim)
            .frame(maxWidth: .infinity, alignment: .leading)
            .fixedSize(horizontal: false, vertical: true)
    }

    /// The current exchange on the page: what you said, then the question,
    /// reply or decision. A reply opens with its Say line, then what it
    /// shows, then its quick replies; a question or decision ends with its
    /// options. All of it scrolls with the page.
    /// With two panes (`split`), the reply's visual blocks are drawn in the
    /// trailing pane instead, and only the conversation stays here.
    @ViewBuilder
    private func current(split: Bool) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            if text.active, !text.heard.isEmpty {
                Text(text.heard)
                    .font(.footnote)
                    .foregroundStyle(OS1VisualStyle.textDim)
                    .frame(maxWidth: .infinity, alignment: .trailing)
                    .multilineTextAlignment(.trailing)
                    .accessibilityLabel("You: \(text.heard)")
            }
            if text.active, let notice = text.notice {
                noticeLine(notice)
            }
            if let ask {
                // The run stopped to ask you something; its reply comes after.
                askView(ask)
            } else if let reply = pageReply(split: split) {
                // The finished reply, drawn with the block catalog as in the
                // OS app; its spoken script only as a caption while it plays.
                // Still being written, plain text until it settles. One view
                // for both, so what you are reading stays put (or slides with
                // its column) as it settles.
                let settled = settledReply != nil
                spokenCaption(reply)
                BlobReplyView(
                    reply: reply,
                    entryId: settled ? text.replyEntry?.id : nil,
                    relay: settled ? text.relay : nil,
                    streaming: !settled,
                    focus: text.focus,
                    scrollIds: true
                )
            } else if let said = decisionSaid {
                BlobSayLine(text: said)
                    .transition(.opacity)
            } else if let decision {
                BlobDecisionView(
                    item: decision,
                    position: decisions.position,
                    count: decisions.count,
                    sending: decisions.sending == decision.id,
                    answer: { option in Task { await decisions.answer(decision, with: option) } },
                    notNow: { decisions.skip(decision) },
                    dismiss: { Task { await decisions.dismiss(decision) } }
                )
                .id(decision.id)
                .transition(reduceMotion ? .opacity : .offset(y: 16).combined(with: .opacity))
            }
        }
        .accessibilityElement(children: .contain)
    }

    /// The spoken script, as a quiet subtitle while Blob says it; it fades
    /// once Blob has said it. It stays when it was not heard: reading aloud
    /// is off, Blob was hushed, or nothing played (no voice fit, a call was
    /// on), since nothing else carries it. A reply without a script shows
    /// its Say line instead.
    @ViewBuilder
    private func spokenCaption(_ reply: BlobReply) -> some View {
        let unheard = !readAloud || text.hushed || !text.speaker.heardReply
        if reply.scripted, !reply.say.isEmpty, text.reading || unheard {
            Text(reply.say)
                .font(.footnote)
                .foregroundStyle(OS1VisualStyle.textDim)
                .frame(maxWidth: .infinity, alignment: .leading)
                .fixedSize(horizontal: false, vertical: true)
                .transition(.opacity.animation(.easeOut(duration: 0.6)))
                .accessibilityLabel("Blob says: \(reply.say)")
        }
    }

    /// The reply as the page draws it: the settled one (only its
    /// conversation beside a second pane) or the one still streaming. Nil
    /// while a question is up or there is none.
    private func pageReply(split: Bool) -> BlobReply? {
        if let content = settledReply {
            return BlobReply(split ? BlobReplySplit(content).conversation : content)
        }
        guard ask == nil, let answer = text.answer else { return nil }
        return BlobReply(answer)
    }

    /// Brings the element the spoken words point at into view on the page:
    /// smoothly, or at once with Reduce Motion. An id the page doesn't carry
    /// is ignored here; beside a second pane, that pane follows its own
    /// (`BlobSidePane`).
    private func follow(_ focus: BlobTextTalk.Focus?, in reply: BlobReply?, with proxy: ScrollViewProxy) {
        guard let focus, let reply, let index = reply.parts.firstIndex(where: { $0.ids.contains(focus.id) })
        else { return }
        let id = BlobReplyView.partId(index)
        if reduceMotion {
            proxy.scrollTo(id, anchor: .center)
        } else {
            withAnimation(.smooth(duration: 0.45)) { proxy.scrollTo(id, anchor: .center) }
        }
    }
}

/// Ids and the coordinate space on Blob's page.
private enum PageMark {
    static let space = "blob.page"
    /// Where the current exchange starts: the end of history.
    static let now = "blob.page.now"
    static let current = "blob.page.current"
    static let end = "blob.page.end"
}

/// The page's scroll, as `onScrollGeometryChange` reports it: the offset
/// from the resting top, the visible height and the content's height.
private struct PageMetrics: Equatable {
    var offset: CGFloat = 0
    var container: CGFloat = 0
    var content: CGFloat = 0
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

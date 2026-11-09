import SwiftUI

/// Blob's home: an empty screen with Blob asleep in its slot. Tap it to talk;
/// it moves to the middle, listens and answers through the Desk's live voice
/// call, then goes back to its slot when you tap it again.
///
/// Talking is a tap, not hold-to-talk: the live call takes a few seconds to
/// connect, and holding would cut off the first words of every sentence.
struct BlobHomeView: View {
    private let engine = DeskVoiceEngine.desk
    @State private var physics = BlobPhysics()
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
                .accessibilityValue(engine.active ? engine.state.label : "Asleep")
                .accessibilityHint(engine.active ? "Ends the conversation" : "Starts a conversation")
                .accessibilityAddTraits(.isButton)
                .accessibilityAction { toggleTalk() }

                captions(insets: insets)
            }
            .contentShape(Rectangle())
            .onTapGesture(coordinateSpace: .local) { location in
                if hit(location) { toggleTalk() }
            }
            .onLongPressGesture { showSettings = true }
            }
            .ignoresSafeArea()
        }
        .background(OS1VisualStyle.background.ignoresSafeArea())
        .sheet(isPresented: $showSettings) { SettingsView() }
        .onAppear {
            if !ServerConfig.shared.isConfigured { showSettings = true }
        }
        .onChange(of: scenePhase) { _, phase in
            // A backgrounded app must never hold the mic open.
            if phase == .background && !engine.shownOutsideApp { engine.stop() }
        }
    }

    private var mode: BlobMode {
        #if DEBUG
        if let demo = BlobDemo.current { return demo.mode }
        #endif
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
        var talking = engine.active, mode = mode, level = Double(engine.audioLevel)
        #if DEBUG
        if let demo = BlobDemo.at(date) { talking = demo.talking; mode = demo.mode; level = demo.level }
        #endif
        return BlobTargets(
            mode: mode,
            position: talking ? center : slot,
            size: talking ? 132 : 48,
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

    private static var demoRunning: Bool {
        #if DEBUG
        BlobDemo.current != nil
        #else
        false
        #endif
    }

    private func toggleTalk() {
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
            if engine.active, let caption = engine.caption, !caption.text.isEmpty {
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
            } else if !hasTalked && !engine.active && !Self.demoRunning {
                Text("Tap me to talk")
                    .font(.footnote)
                    .foregroundStyle(OS1VisualStyle.textFaint)
                    .frame(maxWidth: .infinity, alignment: .trailing)
            }
        }
        .padding(.leading, insets.leading + 24)
        .padding(.trailing, insets.trailing + 24)
        .padding(.bottom, max(insets.bottom, 20) + (engine.active ? 28 : 60))
        .animation(.easeOut(duration: 0.24), value: engine.caption?.text)
        .allowsHitTesting(false)
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

import SwiftUI

/// Your notification inbox: reviews, mentions, workspace invites and
/// reminders, with the read and done state the web shows. Pushed from the bell
/// on iPhone, in a popover from the sidebar's bell on the Mac.
///
/// Tapping a row marks it read and hands its destination to the sessions list
/// through `NotificationInboxStore.openRequest`; this view never navigates.
struct InboxView: View {
    /// The Mac popover draws its own header; the pushed iPhone screen uses the
    /// navigation bar.
    var inPopover = false

    @State private var filter: InboxFilter = .unread
    private var store: NotificationInboxStore { .shared }

    var body: some View {
        let rows = store.rows(filter)
        VStack(spacing: 0) {
            if inPopover {
                HStack {
                    Text("Inbox").font(.headline)
                    Spacer()
                    markAllButton
                        .buttonStyle(.borderless)
                        .controlSize(.small)
                }
                .padding(.horizontal, 14)
                .padding(.top, 12)
                .padding(.bottom, 8)
            }
            Picker("Show", selection: $filter) {
                ForEach(InboxFilter.allCases, id: \.self) { option in
                    Text(label(for: option)).tag(option)
                }
            }
            .pickerStyle(.segmented)
            .labelsHidden()
            .padding(.horizontal, inPopover ? 14 : 16)
            .padding(.bottom, 8)

            if !store.hasLoaded {
                ProgressView()
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                    .accessibilityLabel("Loading notifications")
            } else if rows.isEmpty {
                ContentUnavailableView(
                    emptyTitle,
                    systemImage: filter == .done ? "checkmark.circle" : "tray",
                    description: Text(emptyBody)
                )
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else {
                List {
                    ForEach(rows) { thread in
                        InboxRow(thread: thread)
                    }
                }
                .listStyle(.plain)
                .scrollContentBackground(.hidden)
            }
        }
        .background(OS1VisualStyle.background)
        .navigationTitle("Inbox")
        #if os(iOS)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) { markAllButton }
        }
        .refreshable { await store.hydrate() }
        #endif
        .task { await store.hydrate() }
    }

    private var markAllButton: some View {
        Button("Mark all read") { store.markAllRead() }
            .disabled(store.unreadCount == 0)
    }

    private func label(for option: InboxFilter) -> String {
        let unread = store.unreadCount
        return option == .unread && unread > 0 ? "Unread \(unread)" : option.title
    }

    private var emptyTitle: String {
        switch filter {
        case .unread: "You're all caught up"
        case .all: "No notifications yet"
        case .done: "Nothing marked done"
        }
    }

    private var emptyBody: String {
        switch filter {
        case .unread: "Reviews, mentions, workspace invites and reminders show up here."
        case .all: "When a teammate needs you, it shows up here."
        case .done: "Rows you mark done move here."
        }
    }
}

private struct InboxRow: View {
    let thread: InboxThread
    private var store: NotificationInboxStore { .shared }

    var body: some View {
        Button { store.open(thread) } label: {
            HStack(alignment: .top, spacing: 10) {
                Image(systemName: Self.symbol(thread.knownKind))
                    .font(.callout)
                    .foregroundStyle(Self.tint(thread.knownKind))
                    .frame(width: 22, height: 20)
                VStack(alignment: .leading, spacing: 2) {
                    if let context = thread.subject.context {
                        Text(context)
                            .font(.caption)
                            .foregroundStyle(OS1VisualStyle.textFaint)
                            .lineLimit(1)
                    }
                    HStack(alignment: .firstTextBaseline, spacing: 6) {
                        Text(thread.subject.title.isEmpty ? "Untitled" : thread.subject.title)
                            .font(.subheadline.weight(thread.unread ? .semibold : .regular))
                            .foregroundStyle(OS1VisualStyle.text)
                            .lineLimit(1)
                        Spacer(minLength: 4)
                        Text(thread.updatedDate.formatted(.relative(presentation: .named, unitsStyle: .abbreviated)))
                            .font(.caption)
                            .foregroundStyle(OS1VisualStyle.textFaint)
                            .lineLimit(1)
                    }
                    if !thread.reason.isEmpty {
                        Text(thread.reason)
                            .font(.footnote)
                            .foregroundStyle(OS1VisualStyle.textDim)
                            .lineLimit(2)
                    }
                    if !thread.body.isEmpty {
                        Text(thread.body)
                            .font(.footnote)
                            .foregroundStyle(OS1VisualStyle.textFaint)
                            .lineLimit(2)
                    }
                }
                Circle()
                    .fill(thread.unread ? OS1VisualStyle.accent : .clear)
                    .frame(width: 7, height: 7)
                    .padding(.top, 6)
                    .accessibilityHidden(true)
            }
            .padding(.vertical, 4)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .listRowBackground(Color.clear)
        .accessibilityElement(children: .combine)
        .accessibilityValue(thread.unread ? "Unread" : "")
        .swipeActions(edge: .leading, allowsFullSwipe: true) {
            Button { toggleRead() } label: {
                Label(readLabel, systemImage: thread.unread ? "envelope.open" : "envelope.badge")
            }
            .tint(OS1VisualStyle.blue)
        }
        .swipeActions(edge: .trailing, allowsFullSwipe: true) {
            Button { toggleDone() } label: {
                Label(doneLabel, systemImage: thread.done ? "arrow.uturn.backward" : "checkmark")
            }
            .tint(OS1VisualStyle.accent)
        }
        .contextMenu {
            Button { toggleRead() } label: {
                Label(readLabel, systemImage: thread.unread ? "envelope.open" : "envelope.badge")
            }
            Button { toggleDone() } label: {
                Label(doneLabel, systemImage: thread.done ? "arrow.uturn.backward" : "checkmark")
            }
        }
    }

    private var readLabel: String { thread.unread ? "Mark as read" : "Mark as unread" }
    private var doneLabel: String { thread.done ? "Move to inbox" : "Done" }

    private func toggleRead() { store.mark([thread.id], unread: !thread.unread) }
    private func toggleDone() { store.mark([thread.id], done: !thread.done) }

    static func symbol(_ kind: InboxKind?) -> String {
        switch kind {
        case .reviewRequested: "eye"
        case .reviewDone: "checkmark.circle"
        case .teamReviewRequested: "person.2"
        case .mention: "at"
        case .comment: "text.bubble"
        case .collaborator: "person.2"
        case .reminder: "clock"
        case .incidentHeadsUp: "exclamationmark.triangle"
        case .incidentOpened: "exclamationmark.octagon"
        case .incidentNeedsYou: "questionmark.bubble"
        case .incidentVeto: "paperplane"
        case .incidentRolledBack: "arrow.uturn.backward"
        case .incidentResolved: "checkmark.circle"
        case .incidentUpdate: "circle.dashed"
        case nil: "bell"
        }
    }

    static func tint(_ kind: InboxKind?) -> Color {
        switch kind {
        case .reviewRequested, .reviewDone: OS1VisualStyle.blue
        case .mention, .comment, .collaborator, .incidentNeedsYou: OS1VisualStyle.accent
        case .incidentHeadsUp, .incidentVeto: OS1VisualStyle.yellow
        case .incidentOpened, .incidentRolledBack: OS1VisualStyle.red
        case .incidentResolved: OS1VisualStyle.green
        case .teamReviewRequested, .reminder, .incidentUpdate, nil: OS1VisualStyle.textDim
        }
    }
}

/// The bell that opens the inbox. A badge-dot glyph while anything is unread,
/// like the web's.
struct InboxBellLabel: View {
    private var store: NotificationInboxStore { .shared }

    var body: some View {
        let unread = store.unreadCount
        Image(systemName: unread > 0 ? "bell.badge" : "bell")
            // Palette: the badge layer takes the accent, the bell stays ink.
            .symbolRenderingMode(.palette)
            .foregroundStyle(OS1VisualStyle.accent, OS1VisualStyle.text)
            .accessibilityLabel(unread == 1 ? "Inbox, 1 unread" : unread > 0 ? "Inbox, \(unread) unread" : "Inbox")
    }
}

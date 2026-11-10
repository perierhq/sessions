import Foundation

// The Mac menu commands' notifications. Their own file, not OS1App.swift, so
// apps that bring their own entry point (Blob for Mac) still compile the
// views that listen for them.
#if os(macOS)
extension Notification.Name {
    /// Posted by the File > New Session menu command; the sessions list opens
    /// its new-session sheet in response.
    static let os1NewSession = Notification.Name("os1.newSession")
    /// File > New Session in This Workspace: a sibling of the open session,
    /// sharing its workspace, worktree and branch.
    static let os1NewSessionInWorkspace = Notification.Name("os1.newSessionInWorkspace")
    /// View > Command Palette. Toggles like the web command does.
    static let os1CommandPalette = Notification.Name("os1.commandPalette")
    /// File > Reopen Archived: restore the last workspace or tab archived in
    /// the window.
    static let os1ReopenArchived = Notification.Name("os1.reopenArchived")
}
#endif

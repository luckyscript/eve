import SwiftUI
import AppKit

@MainActor final class AppDelegate: NSObject, NSApplicationDelegate {
 weak var model: AppModel?
 func applicationDidFinishLaunching(_ notification: Notification) { NSApp.setActivationPolicy(.regular); NSApp.applicationIconImage = NSImage(systemSymbolName: "sparkle", accessibilityDescription: "Eve") }
 func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
  if model?.busy == true {
   let alert = NSAlert(); alert.messageText = "任务仍在运行"; alert.informativeText = "请先取消并等待任务收尾，再退出。已写入的产物会保留。"; alert.runModal(); return .terminateCancel
  }
  return .terminateNow
 }
}
@main struct EveApp: App {
 @NSApplicationDelegateAdaptor(AppDelegate.self) private var delegate
 @StateObject private var model = AppModel()
 var body: some Scene {
  WindowGroup("Eve") {
   ContentView(model: model)
    .frame(minWidth: 1020, minHeight: 720)
    .onAppear { delegate.model = model; model.restore() }
  }.defaultSize(width: 1250, height: 860)
   .commands {
    CommandGroup(replacing: .newItem) { Button("新会话") { model.newSession() }.keyboardShortcut("n").disabled(model.busy); Button("选择工作区…") { model.chooseWorkspace() }.keyboardShortcut("o").disabled(model.busy) }
   }
 }
}

import SwiftUI
import AppKit

@MainActor final class AppDelegate: NSObject, NSApplicationDelegate {
 weak var model: AppModel?
 var reopen: (() -> Void)?
 private var terminationPending = false
 func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { false }
 func applicationDidFinishLaunching(_ notification: Notification) { NSApp.setActivationPolicy(.regular); NSApp.applicationIconImage = EveBrand.icon }
 func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
  if !flag {
   if let window = sender.windows.first(where: { $0.title == "Eve" && $0.canBecomeMain }) { window.makeKeyAndOrderFront(nil) }
   else { reopen?() }
   sender.activate(ignoringOtherApps: true)
  }
  return true
 }
 func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
  guard !terminationPending else { return .terminateLater }
  if model?.settingsDirty == true {
   let alert = NSAlert(); alert.messageText = "有未保存的设置"; alert.informativeText = "返回保存设置，或放弃设置编辑后退出。"; alert.addButton(withTitle: "返回设置"); alert.addButton(withTitle: "放弃并继续退出")
   if alert.runModal() == .alertFirstButtonReturn { model?.page = .settings; return .terminateCancel }
  }
  if model?.isRunning == true || model?.bridge.awaitingSettlement == true {
   let alert = NSAlert(); alert.messageText = "任务仍在运行或收尾"; alert.informativeText = "取消后等待核心结束写入再退出。已写入的产物会保留。"; alert.addButton(withTitle: "返回应用"); alert.addButton(withTitle: "取消并等待后退出")
   guard alert.runModal() == .alertSecondButtonReturn else { return .terminateCancel }
   model?.cancel()
   terminationPending = true
   Task { @MainActor [self] in
    while model?.isRunning == true || model?.bridge.awaitingSettlement == true {
     if let state = model?.cancelState, state.contains("失败") || state.contains("未命中") { terminationPending = false; sender.reply(toApplicationShouldTerminate: false); return }
     try? await Task.sleep(for: .milliseconds(200))
    }
    await finishTermination(sender)
   }
   return .terminateLater
  }
  terminationPending = true
  Task { @MainActor [self] in await finishTermination(sender) }
  return .terminateLater
 }
 private func finishTermination(_ sender: NSApplication) async {
  let saved = await model?.flushDrafts() ?? true
  var shouldQuit = saved
  if !saved {
   let alert = NSAlert(); alert.alertStyle = .warning
   alert.messageText = "草稿未能安全保存"
   alert.informativeText = (model?.draftPersistenceNotice ?? "草稿仍在内存中。") + "\n返回应用可保留当前编辑；仍然退出可能丢失尚未保存的草稿。"
   alert.addButton(withTitle: "返回应用"); alert.addButton(withTitle: "仍然退出")
   shouldQuit = alert.runModal() == .alertSecondButtonReturn
  }
  terminationPending = false
  sender.reply(toApplicationShouldTerminate: shouldQuit)
 }

}
@main struct EveApp: App {
 @NSApplicationDelegateAdaptor(AppDelegate.self) private var delegate
 @StateObject private var model = AppModel()
 var body: some Scene {
  Window("Eve", id: "main") {
   EveWindowRoot(model: model, delegate: delegate).frame(minWidth: 900, minHeight: 640)
  }.defaultSize(width: 1180, height: 820)
   .commands {
    CommandGroup(replacing: .appSettings) { Button("设置…") { model.page = .settings }.keyboardShortcut(",") }
    CommandGroup(after: .textEditing) { Button("搜索会话") { NotificationCenter.default.post(name: .eveSearch, object: nil) }.keyboardShortcut("f") }
    CommandGroup(replacing: .newItem) { Button("新会话") { model.newSession() }.keyboardShortcut("n"); Button("选择工作区…") { model.chooseWorkspace() }.keyboardShortcut("o").disabled(model.busy) }
   }
 }
}

private struct EveWindowRoot: View {
 @ObservedObject var model: AppModel
 let delegate: AppDelegate
 @Environment(\.openWindow) private var openWindow
 var body: some View {
  ContentView(model: model).onAppear {
   delegate.model = model; delegate.reopen = { openWindow(id: "main") }; model.restore()
  }
 }
}

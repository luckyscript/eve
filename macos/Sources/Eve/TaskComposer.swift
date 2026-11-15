import SwiftUI
import AppKit
import EveProtocol

struct TaskComposer: NSViewRepresentable {
 @Binding var text: String
 @Binding var height: CGFloat
 var enterNewline: Bool
 var focusToken: Int
 var submit: () -> Void
 func makeCoordinator() -> Coordinator { Coordinator(self) }
 func makeNSView(context: Context) -> NSScrollView {
  let scroll = NSScrollView()
  let editor = TaskTextView(frame: .zero)
  editor.isRichText = false; editor.isAutomaticQuoteSubstitutionEnabled = false
  editor.isAutomaticDashSubstitutionEnabled = false; editor.allowsUndo = true
  editor.font = .systemFont(ofSize: 14); editor.drawsBackground = false
  editor.textContainerInset = NSSize(width: 4, height: 8)
  editor.minSize = NSSize(width: 0, height: 54); editor.maxSize = NSSize(width: CGFloat.greatestFiniteMagnitude, height: CGFloat.greatestFiniteMagnitude)
  editor.isVerticallyResizable = true; editor.isHorizontallyResizable = false
  editor.autoresizingMask = [.width]
  editor.textContainer?.widthTracksTextView = true
  editor.setAccessibilityLabel("任务输入")
  editor.delegate = context.coordinator
  editor.onResize = { [weak editor, weak coordinator = context.coordinator] in DispatchQueue.main.async { if let editor { coordinator?.measure(editor) } } }
  scroll.documentView = editor; scroll.drawsBackground = false; scroll.hasVerticalScroller = true
  return scroll
 }
 func updateNSView(_ scroll: NSScrollView, context: Context) {
  context.coordinator.parent = self
  guard let editor = scroll.documentView as? TaskTextView else { return }
  if editor.string != text && !editor.hasMarkedText() { editor.string = text; editor.setSelectedRange(NSRange(location: text.utf16.count, length: 0)); editor.undoManager?.removeAllActions() }
  editor.enterNewline = enterNewline; editor.onSubmit = submit
  if context.coordinator.focusToken != focusToken {
   context.coordinator.focusToken = focusToken
   DispatchQueue.main.async { [weak editor] in guard let editor else { return }; editor.window?.makeFirstResponder(editor) }
  }
  context.coordinator.measure(editor)
 }
 static func dismantleNSView(_ scroll: NSScrollView, coordinator: Coordinator) {
  if let editor = scroll.documentView as? TaskTextView { editor.delegate = nil; editor.onSubmit = nil; editor.onResize = nil }
 }
 @MainActor final class Coordinator: NSObject, NSTextViewDelegate {
  var parent: TaskComposer
  var focusToken = -1
  init(_ parent: TaskComposer) { self.parent = parent }
  func textDidChange(_ notification: Notification) {
   guard let editor = notification.object as? TaskTextView else { return }
   parent.text = editor.string; measure(editor)
  }
  func measure(_ editor: NSTextView) {
   guard let container = editor.textContainer, let layout = editor.layoutManager else { return }
   layout.ensureLayout(for: container)
   let size = min(220, max(54, layout.usedRect(for: container).height + 20))
   if abs(parent.height - size) > 1 { DispatchQueue.main.async { self.parent.height = size } }
  }
 }
}

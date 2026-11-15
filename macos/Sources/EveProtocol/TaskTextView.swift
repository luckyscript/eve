#if canImport(AppKit)
import AppKit

/// AppKit owns composition and paste. Only an unmarked Return may submit.
@MainActor public final class TaskTextView: NSTextView {
 public var enterNewline = false
 public var onSubmit: (() -> Void)?
 public var onResize: (() -> Void)?
 private var confirmingComposition = false
 public override func setFrameSize(_ newSize: NSSize) { let changed = frame.width != newSize.width; super.setFrameSize(newSize); if changed { onResize?() } }
 public override func keyDown(with event: NSEvent) {
  if event.keyCode == 36 || event.keyCode == 76 {
   switch ComposerPolicy.returnAction(marked: hasMarkedText(), shift: event.modifierFlags.contains(.shift), command: event.modifierFlags.contains(.command), enterNewline: enterNewline) {
   case .confirmComposition:
    confirmingComposition = true
    defer { confirmingComposition = false }
    super.keyDown(with: event)
   case .newline: insertNewline(nil)
   case .submit: onSubmit?()
   }
  } else { super.keyDown(with: event) }
 }
 public override func doCommand(by selector: Selector) {
  if selector == #selector(insertNewline(_:)), !hasMarkedText(), !confirmingComposition {
   if enterNewline { super.doCommand(by: selector) } else { onSubmit?() }
  } else { super.doCommand(by: selector) }
 }
 public override func paste(_ sender: Any?) { pasteAsPlainText(sender) }
}
#endif

import XCTest
import AppKit
@testable import EveProtocol

final class ComposerTests: XCTestCase {
 func testReturnPolicyCompositionAlwaysWins() {
  for shift in [false, true] {
   for command in [false, true] {
    for preference in [false, true] {
     XCTAssertEqual(ComposerPolicy.returnAction(marked: true, shift: shift, command: command, enterNewline: preference), .confirmComposition)
    }
   }
  }
 }
 func testReturnPreferenceAndShift() {
  XCTAssertEqual(ComposerPolicy.returnAction(marked: false, shift: false, command: false, enterNewline: false), .submit)
  XCTAssertEqual(ComposerPolicy.returnAction(marked: false, shift: false, command: false, enterNewline: true), .newline)
  XCTAssertEqual(ComposerPolicy.returnAction(marked: false, shift: false, command: true, enterNewline: true), .submit)
  XCTAssertEqual(ComposerPolicy.returnAction(marked: false, shift: true, command: true, enterNewline: false), .newline)
 }
 func testValidationUsesUTF16AndRejectsWhitespace() {
  XCTAssertNotNil(ComposerPolicy.validation(" \n\t\u{3000}"))
  XCTAssertNil(ComposerPolicy.validation(String(repeating: "😀", count: 8000)))
  XCTAssertNotNil(ComposerPolicy.validation(String(repeating: "😀", count: 8001)))
  XCTAssertNil(ComposerPolicy.validation(String(repeating: "a", count: 16000)))
  XCTAssertNotNil(ComposerPolicy.validation(String(repeating: "a", count: 16001)))
 }
 func testCachedWorkspaceCannotSendToOriginHost() {
  XCTAssertTrue(WorkspaceRouting.allows(op: "run", connected: "/origin", browsing: "/origin"))
  for op in ["run", "secret", "configure", "remote.status", "session.page"] {
   XCTAssertFalse(WorkspaceRouting.allows(op: op, connected: "/origin", browsing: "/cached"))
  }
  XCTAssertTrue(WorkspaceRouting.allows(op: "cancel", connected: "/origin", browsing: "/cached"))
  XCTAssertTrue(WorkspaceRouting.allows(op: "session.page", connected: "/origin", browsing: "/cached", expected: "/origin"))
  XCTAssertFalse(WorkspaceRouting.allows(op: "sessions", connected: "", browsing: ""))
  XCTAssertTrue(WorkspaceRouting.allows(op: "workspace", connected: "", browsing: "/new"))
 }
 func testModelDeadlineIsNotControlDeadline() {
  XCTAssertEqual(BridgeTimeout.seconds(op: "cancel"), 20)
  XCTAssertGreaterThan(BridgeTimeout.seconds(op: "run", timeoutMs: 600000, steps: 100, evolutionMs: 1800000), 60000)
  XCTAssertGreaterThanOrEqual(BridgeTimeout.seconds(op: "evolve", evolutionMs: 1800000), 1800)
 }

 // These dispatch real AppKit editing actions. A programmatic marked range is
 // a composition routing regression check, not certification of a physical IME.
 func testActualTextViewReturnNewlinePreferenceAndPaste() async {
  await MainActor.run {
   _ = NSApplication.shared
   let editor = TaskTextView(frame: NSRect(x: 0, y: 0, width: 400, height: 100))
   editor.isRichText = false
   var sends = 0; editor.onSubmit = { sends += 1 }
   @MainActor func press(_ modifiers: NSEvent.ModifierFlags = []) {
    let event = NSEvent.keyEvent(with: .keyDown, location: .zero, modifierFlags: modifiers, timestamp: 0, windowNumber: 0, context: nil, characters: "\r", charactersIgnoringModifiers: "\r", isARepeat: false, keyCode: 36)!
    editor.keyDown(with: event)
   }
   editor.string = "任务"; editor.setSelectedRange(NSRange(location: 2, length: 0))
   press(); XCTAssertEqual(sends, 1); XCTAssertEqual(editor.string, "任务")
   press(.shift); XCTAssertEqual(sends, 1); XCTAssertEqual(editor.string, "任务\n")
   editor.enterNewline = true
   press(); XCTAssertEqual(sends, 1); XCTAssertEqual(editor.string, "任务\n\n")
   press(.command); XCTAssertEqual(sends, 2)
   let board = NSPasteboard.general
   // Preserve existing clipboard data while exercising the actual paste action.
   let saved = board.pasteboardItems?.map { item in item.types.compactMap { type in item.data(forType: type).map { (type, $0) } } } ?? []
   defer {
    board.clearContents()
    let items = saved.map { values in let item = NSPasteboardItem(); for (type, data) in values { item.setData(data, forType: type) }; return item }
    if !items.isEmpty { board.writeObjects(items) }
   }
   board.clearContents(); board.setString("粘贴\n不发送", forType: .string)
   editor.paste(nil)
   XCTAssertTrue(editor.string.contains("粘贴\n不发送")); XCTAssertEqual(sends, 2)
  }
 }
 func testActualTextViewMarkedRangeDoesNotSubmit() async {
  await MainActor.run {
   _ = NSApplication.shared
   let editor = TaskTextView(frame: NSRect(x: 0, y: 0, width: 400, height: 100))
   var sends = 0; editor.onSubmit = { sends += 1 }
   editor.setMarkedText("候选", selectedRange: NSRange(location: 2, length: 0), replacementRange: NSRange(location: NSNotFound, length: 0))
   XCTAssertTrue(editor.hasMarkedText())
   let event = NSEvent.keyEvent(with: .keyDown, location: .zero, modifierFlags: [], timestamp: 0, windowNumber: 0, context: nil, characters: "\r", charactersIgnoringModifiers: "\r", isARepeat: false, keyCode: 36)!
   editor.keyDown(with: event)
   XCTAssertEqual(sends, 0)
  }
 }
 func testFencedCodeAndIncompleteStreamPreserveContent() {
  let blocks = MessageBlocks.parse("说明\n```swift\nlet x = 1\n```\n结束")
  XCTAssertEqual(blocks.count, 3)
  XCTAssertEqual(blocks[1].kind, .code("swift")); XCTAssertEqual(blocks[1].text, "let x = 1")
  let incomplete = MessageBlocks.parse("```\nhello\nworld")
  XCTAssertEqual(incomplete.first?.text, "hello\nworld")
  XCTAssertEqual(incomplete.first?.kind, .code(""))
 }
 func testTableFallbackRetainsAllCells() {
  let table = "| 名称 | 值 |\n| --- | --- |\n| a | 中文 |"
  XCTAssertEqual(MessageBlocks.parse(table).first?.kind, .table)
  XCTAssertEqual(MessageBlocks.parse(table).first?.text, table)
 }
 func testCompletionClearsOnlySuccessfulUneditedOriginDraft() {
  let origin = ConversationKey(workspace: "/one", session: "s-origin")
  let browsing = ConversationKey(workspace: "/two", session: "s-other")
  var store = ConversationDrafts()
  var submitted = ConversationDraft(); submitted.prompt = "运行文本"; submitted.contract = "contract.json"; submitted.autoEvolve = true
  var other = ConversationDraft(); other.prompt = "另一个工作区的草稿"
  store[origin] = submitted; store[browsing] = other
  store.complete(origin, submitted: submitted.prompt, succeeded: false)
  XCTAssertEqual(store[origin], submitted)
  store[origin]?.prompt = "运行期间继续编辑"
  store.complete(origin, submitted: submitted.prompt, succeeded: true)
  XCTAssertEqual(store[origin]?.prompt, "运行期间继续编辑")
  store[origin] = submitted
  store.complete(origin, submitted: submitted.prompt, succeeded: true)
  XCTAssertEqual(store[origin]?.prompt, "")
  XCTAssertEqual(store[origin]?.contract, "contract.json")
  XCTAssertEqual(store[browsing], other)
  XCTAssertNil(store[ConversationKey(workspace: "/one", session: "s-new")])
 }
 func testWorkspaceAndUnsentSessionIdentityDoNotCollide() {
  let a = ConversationKey(workspace: "/one", session: "s-a")
  let b = ConversationKey(workspace: "/two", session: "s-a")
  let c = ConversationKey(workspace: "/one", session: "s-b")
  var draft = ConversationDraft(); draft.prompt = "保留"; draft.contract = "test.json"; draft.autoEvolve = true
  let drafts = [a: draft]
  XCTAssertEqual(drafts[a]?.prompt, "保留")
  XCTAssertNil(drafts[b]); XCTAssertNil(drafts[c])
  XCTAssertFalse(ConversationDraft().autoEvolve); XCTAssertTrue(ConversationDraft().contract.isEmpty)
 }
}

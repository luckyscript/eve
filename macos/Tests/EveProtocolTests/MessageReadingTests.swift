import XCTest
@testable import EveProtocol

final class MessageReadingTests: XCTestCase {
 func testTableDoesNotConsumeSurroundingProseOrCode() {
  let source = "# 结果\n说明文字\n\n| 项目 | 数量 |\n| :--- | ---: |\n| 文件 | 2 |\n\n结束说明\n```swift\nlet value = \"a|b---\"\n```"
  let blocks = MessageBlocks.parse(source)
  XCTAssertEqual(blocks.map(\.kind), [.prose, .table, .prose, .code("swift")])
  XCTAssertTrue(blocks[0].text.contains("# 结果"))
  XCTAssertTrue(blocks[1].text.contains("| 文件 | 2 |"))
  XCTAssertTrue(blocks[2].text.contains("结束说明"))
  XCTAssertEqual(blocks[3].text, "let value = \"a|b---\"")
 }
 func testOrdinaryPipeAndDashesDoNotBecomeTable() {
  let source = "Use a | b --- then continue.\nThe prose stays selectable."
  let blocks = MessageBlocks.parse(source)
  XCTAssertEqual(blocks.count, 1)
  XCTAssertEqual(blocks.first?.kind, .prose)
  XCTAssertEqual(blocks.first?.text, source)
 }
 func testIncompleteStreamedCodeKeepsEveryCharacter() {
  let source = "```json\n{\"emoji\":\"😀\",\"partial\":"
  let blocks = MessageBlocks.parse(source)
  XCTAssertEqual(blocks.first?.kind, .code("json"))
  XCTAssertEqual(blocks.first?.text, "{\"emoji\":\"😀\",\"partial\":")
 }
}

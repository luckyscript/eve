import XCTest
@testable import EveProtocol

final class SessionPresentationTests: XCTestCase {
 // Catch whitespace-only titles, broken grapheme truncation and ID-as-title regressions.
 func testTitlesUsePromptAndPreserveUnicode() {
  XCTAssertEqual(SessionPresentation.title(prompt: " \n Review   this\tworkspace \n safely "), "Review this workspace safely")
  XCTAssertEqual(SessionPresentation.title(prompt: " \n "), "未命名会话")
  XCTAssertEqual(SessionPresentation.title(prompt: String(repeating: "👩🏽‍💻", count: 60)).count, 49)
  XCTAssertEqual(SessionPresentation.title(prompt: "修复登录流程"), "修复登录流程")
 }
 // Catch case/diacritic-sensitive search, empty-query exclusion and missing ID lookup.
 func testSearchFindsTitleOrIDWithoutCaseOrDiacritics() {
  XCTAssertTrue(SessionPresentation.matches(query: " CAFE ", title: "Café notes", id: "s-123"))
  XCTAssertTrue(SessionPresentation.matches(query: "S-123", title: "修复登录", id: "s-123"))
  XCTAssertTrue(SessionPresentation.matches(query: "\n ", title: "", id: "s-123"))
  XCTAssertFalse(SessionPresentation.matches(query: "missing", title: "Café notes", id: "s-123"))
 }
}

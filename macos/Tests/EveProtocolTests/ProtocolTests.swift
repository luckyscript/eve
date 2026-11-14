import XCTest
@testable import EveProtocol
final class ProtocolTests: XCTestCase {
 func testFragmentedUnicodeAndMultipleFrames() throws {
  var decoder = LineDecoder()
  let bytes = Data("{\"type\":\"event\",\"event\":\"中文\"}\n{\"type\":\"result\"}\n".utf8)
  XCTAssertTrue(try decoder.append(bytes.prefix(12)).isEmpty)
  let frames = try decoder.append(bytes.dropFirst(12))
  XCTAssertEqual(frames.count, 2)
  XCTAssertEqual(frames[0]["event"] as? String, "中文")
  XCTAssertNoThrow(try decoder.finish())
 }
 func testLimitsAndTruncatedEOF() throws {
  var decoder = LineDecoder(limit: 10)
  XCTAssertThrowsError(try decoder.append(Data(repeating: 65, count: 11)))
  var partial = LineDecoder()
  _ = try partial.append(Data("{".utf8))
  XCTAssertThrowsError(try partial.finish())
 }
 func testInvalidFrameIsFailure() {
  var decoder = LineDecoder()
  XCTAssertThrowsError(try decoder.append(Data("[]\n".utf8)))
 }
}

final class ConfigurationPatchTests: XCTestCase {
 func testChangingBudgetDoesNotWriteRedactedUneditedModel() throws {
  let baseline = ["model": "local-[redacted]/model", "timeoutMs": "90000", "skillsDirs": "skills"]
  var draft = baseline; draft["timeoutMs"] = "120000"
  let patch = try JSONSerialization.jsonObject(with: ConfigurationPatch.make(baseline: baseline, draft: draft)) as! [String: Any]
  XCTAssertEqual(patch.count, 1)
  XCTAssertEqual(patch["timeoutMs"] as? Int, 120000)
  XCTAssertNil(patch["model"])
 }
 func testEditingRedactedValueRequiresCompleteReplacement() {
  XCTAssertThrowsError(try ConfigurationPatch.make(baseline: ["model": "local-[redacted]"], draft: ["model": "local-[redacted]-new"]))
 }
 func testNoEditsProducesEmptyPatchAndDirectoriesKeepSpaces() throws {
  let empty = try JSONSerialization.jsonObject(with: ConfigurationPatch.make(baseline: ["model": "old"], draft: ["model": "old"])) as! [String: Any]
  XCTAssertTrue(empty.isEmpty)
  let patch = try JSONSerialization.jsonObject(with: ConfigurationPatch.make(baseline: [:], draft: ["skillsDirs": "skills\nmy skills", "userSkills": "true"])) as! [String: Any]
  XCTAssertEqual(patch["skillsDirs"] as? [String], ["skills", "my skills"])
  XCTAssertEqual(patch["userSkills"] as? Bool, true)
 }
}

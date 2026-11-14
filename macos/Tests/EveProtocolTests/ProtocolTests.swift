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

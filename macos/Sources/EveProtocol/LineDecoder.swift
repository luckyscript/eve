import Foundation
public struct LineDecoder {
 private var buffer = Data()
 public let limit: Int
 public init(limit: Int = 2 * 1024 * 1024) { self.limit = limit }
 public mutating func append(_ data: Data) throws -> [[String: Any]] {
  buffer.append(data)
  var frames: [[String: Any]] = []
  while let end = buffer.firstIndex(of: 10) {
   guard end <= limit else { throw ProtocolError.oversized }
   guard let frame = try JSONSerialization.jsonObject(with: buffer.prefix(end)) as? [String: Any] else { throw ProtocolError.invalid }
   frames.append(frame)
   buffer.removeSubrange(...end)
  }
  guard buffer.count <= limit else { throw ProtocolError.oversized }
  return frames
 }
 public func finish() throws { if !buffer.isEmpty { throw ProtocolError.truncated } }
}
public enum ProtocolError: Error { case oversized, invalid, truncated }

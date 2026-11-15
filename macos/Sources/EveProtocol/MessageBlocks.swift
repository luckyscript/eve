import Foundation

public struct MessageBlock: Equatable, Identifiable {
 public enum Kind: Equatable { case prose, code(String), table }
 public let id: Int
 public let kind: Kind
 public let text: String
}
public enum MessageBlocks {
 /// Fences preserve their contents verbatim, including incomplete streamed fences.
 /// Pipe tables use a selectable monospace fallback so no cell is discarded.
 public static func parse(_ message: String) -> [MessageBlock] {
  var blocks: [MessageBlock] = [], lines: [String] = []
  var fence: String?, language = ""
  func flush(_ kind: MessageBlock.Kind) {
   guard !lines.isEmpty else { return }
   blocks.append(MessageBlock(id: blocks.count, kind: kind, text: lines.joined(separator: "\n"))); lines = []
  }
  for line in message.components(separatedBy: "\n") {
   let trimmed = line.trimmingCharacters(in: .whitespaces)
   if let current = fence {
    if trimmed.hasPrefix(current), trimmed.dropFirst(current.count).allSatisfy({ $0 == current.first! }) {
     flush(.code(language)); fence = nil
    } else { lines.append(line) }
   } else if trimmed.hasPrefix("```") || trimmed.hasPrefix("~~~") {
    flush(.prose)
    let marker = trimmed.first!
    let count = trimmed.prefix(while: { $0 == marker }).count
    fence = String(repeating: String(marker), count: count)
    language = String(trimmed.dropFirst(count))
   } else { lines.append(line) }
  }
  flush(fence == nil ? .prose : .code(language))
  var result: [MessageBlock] = []
  func append(_ kind: MessageBlock.Kind, _ text: String) { result.append(MessageBlock(id: result.count, kind: kind, text: text)) }
  func delimiter(_ line: String) -> Bool {
   let trimmed = line.trimmingCharacters(in: .whitespaces)
   guard trimmed.contains("|") else { return false }
   var cells = trimmed.components(separatedBy: "|")
   if cells.first?.trimmingCharacters(in: .whitespaces).isEmpty == true { cells.removeFirst() }
   if cells.last?.trimmingCharacters(in: .whitespaces).isEmpty == true { cells.removeLast() }
   return !cells.isEmpty && cells.allSatisfy { $0.trimmingCharacters(in: .whitespaces).range(of: #"^:?-{3,}:?$"#, options: .regularExpression) != nil }
  }
  for block in blocks {
   guard block.kind == .prose else { append(block.kind, block.text); continue }
   let source = block.text.components(separatedBy: "\n")
   var prose: [String] = [], index = 0
   while index < source.count {
    if index + 1 < source.count, source[index].contains("|"), delimiter(source[index + 1]) {
     if !prose.isEmpty { append(.prose, prose.joined(separator: "\n")); prose = [] }
     var table = [source[index], source[index + 1]]; index += 2
     while index < source.count, source[index].contains("|"), !source[index].trimmingCharacters(in: .whitespaces).isEmpty { table.append(source[index]); index += 1 }
     append(.table, table.joined(separator: "\n"))
    } else { prose.append(source[index]); index += 1 }
   }
   if !prose.isEmpty { append(.prose, prose.joined(separator: "\n")) }
  }
  return result
 }
}

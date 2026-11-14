import Foundation

/// Pure presentation rules shared by the native session list and its header.
public enum SessionPresentation {
 public static func title(prompt: String) -> String {
  let normalized = prompt.split(whereSeparator: { $0.isWhitespace }).joined(separator: " ")
  guard !normalized.isEmpty else { return "未命名会话" }
  return normalized.count > 48 ? String(normalized.prefix(48)) + "…" : normalized
 }
 public static func matches(query: String, title: String, id: String) -> Bool {
  let query = query.trimmingCharacters(in: .whitespacesAndNewlines)
  return query.isEmpty || [title, id].contains { $0.range(of: query, options: [.caseInsensitive, .diacriticInsensitive]) != nil }
 }
}

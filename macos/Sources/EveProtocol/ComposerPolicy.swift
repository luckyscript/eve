import Foundation

public enum ComposerPolicy {
 public static let limit = 16000
 public enum ReturnAction: Equatable { case confirmComposition, newline, submit }
 public static func returnAction(marked: Bool, shift: Bool, command: Bool, enterNewline: Bool) -> ReturnAction {
  if marked { return .confirmComposition }
  if shift { return .newline }
  return command || !enterNewline ? .submit : .newline
 }
 public static func validation(_ value: String) -> String? {
  if value.utf16.count > limit { return "输入超过 16000 UTF-16 单元，请缩短后发送。" }
  if value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { return "请输入任务内容。" }
  return nil
 }
}

/// Identity includes the workspace and an explicit ID for every unsent conversation.
public struct ConversationKey: Hashable, Codable, Sendable {
 public let workspace: String
 public let session: String
 public init(workspace: String, session: String) { self.workspace = workspace; self.session = session }
}
public struct ConversationDraft: Equatable, Codable, Sendable {
 public var prompt = ""
 public var contract = ""
 public var contractState = "未选择 · 不进行独立验收"
 public var autoEvolve = false
 public init() {}
 public var isEmpty: Bool { prompt.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && contract.isEmpty && !autoEvolve }
}

public struct ConversationDrafts: Sendable {
 private var storage: [ConversationKey: ConversationDraft] = [:]
 public init() {}
 public init(snapshot: [ConversationKey: ConversationDraft]) { storage = snapshot.filter { !$0.value.isEmpty } }
 public var snapshot: [ConversationKey: ConversationDraft] { storage }
 public var keys: [ConversationKey] { Array(storage.keys) }
 public subscript(_ key: ConversationKey) -> ConversationDraft? {
  get { storage[key] }
  set { storage[key] = newValue?.isEmpty == true ? nil : newValue }
 }
 public mutating func complete(_ key: ConversationKey, submitted: String, succeeded: Bool) {
  guard succeeded, storage[key]?.prompt == submitted else { return }
  self[key]?.prompt = ""
 }
}

public enum WorkspaceRouting {
 public static func allows(op: String, connected: String, browsing: String, expected: String? = nil) -> Bool {
  if ["workspace", "busy", "cancel"].contains(op) { return true }
  let destination = expected ?? browsing
  return !destination.isEmpty && connected == destination
 }
}

public enum BridgeTimeout {
 /// Model work is bounded by the core's budget, never the control RPC deadline.
 public static func seconds(op: String, timeoutMs: Double = 90000, steps: Double = 12, evolutionMs: Double = 0) -> Double {
  switch op {
  case "run", "compact": return max(60, timeoutMs / 1000 * max(1, steps) + evolutionMs / 1000 + 60)
  case "evolve": return max(60, evolutionMs / 1000 + 60)
  case "connection.test": return 15
  default: return 20
  }
 }
}

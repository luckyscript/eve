import Foundation
import Darwin

/// Only composer state belongs here. Workspace and contract paths are opaque data.
public struct DraftSnapshot: Codable, Sendable {
 public static let maxFileBytes = 8 * 1024 * 1024
 public static let maxDrafts = 256
 public static let maxWorkspaces = 256
 public static let maxPromptUTF16 = 262144
 public struct Entry: Codable, Sendable {
  public let key: ConversationKey
  public var draft: ConversationDraft
 }
 public var version = 1
 public var entries: [Entry]
 public var workspaceDraftIDs: [String: String]
 public init(drafts: ConversationDrafts = ConversationDrafts(), workspaceDraftIDs: [String: String] = [:]) {
  entries = drafts.snapshot.map { Entry(key: $0.key, draft: $0.value) }
  let retained = Set(entries.map(\.key))
  self.workspaceDraftIDs = workspaceDraftIDs.filter { retained.contains(ConversationKey(workspace: $0.key, session: $0.value)) }
 }
 public var drafts: ConversationDrafts {
  ConversationDrafts(snapshot: Dictionary(entries.map { ($0.key, $0.draft) }, uniquingKeysWith: { _, last in last }))
 }
 public func validated() throws -> DraftSnapshot {
  guard version == 1 else { throw DraftPersistenceFailure.unsupportedVersion }
  guard entries.count <= Self.maxDrafts, workspaceDraftIDs.count <= Self.maxWorkspaces else { throw DraftPersistenceFailure.limit }
  var result = self
  var seen = Set<ConversationKey>()
  for entry in entries {
   guard seen.insert(entry.key).inserted else { throw DraftPersistenceFailure.corrupt }
   guard entry.key.workspace.utf8.count <= 16384, !entry.key.session.isEmpty, entry.key.session.utf8.count <= 4096,
    entry.draft.prompt.utf16.count <= Self.maxPromptUTF16, entry.draft.contract.utf8.count <= 16384,
    entry.draft.contractState.utf8.count <= 4096 else { throw DraftPersistenceFailure.limit }
  }
  for (workspace, id) in workspaceDraftIDs {
   guard workspace.utf8.count <= 16384, !id.isEmpty, id.utf8.count <= 4096 else { throw DraftPersistenceFailure.limit }
  }
  result.entries = entries.compactMap { entry in
   var entry = entry
   if entry.draft.prompt.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { entry.draft.prompt = "" }
   guard !entry.draft.prompt.isEmpty || !entry.draft.contract.isEmpty || entry.draft.autoEvolve else { return nil }
   return entry
  }.sorted { ($0.key.workspace, $0.key.session) < ($1.key.workspace, $1.key.session) }
  // A workspace ID is useful only if it points at an actual unsent draft.
  let retained = Set(result.entries.map(\.key))
  result.workspaceDraftIDs = workspaceDraftIDs.filter { retained.contains(ConversationKey(workspace: $0.key, session: $0.value)) }
  return result
 }
}

public enum DraftPersistenceFailure: Error, LocalizedError, Sendable {
 case location, unsafePath, io, corrupt, unsupportedVersion, limit, externalChange
 public var errorDescription: String? {
  switch self {
  case .location: return "无法确定独立的草稿目录；需要有效的应用 Bundle identifier。"
  case .unsafePath: return "草稿路径不安全（符号链接、文件类型或所有者异常）；未覆盖原文件。"
  case .io: return "无法读写草稿文件，请检查 Application Support 的可用空间与权限。"
  case .externalChange: return "草稿文件在加载后发生外部变化；原文件已保留，自动保存已暂停。请先备份 drafts.json 并重启，再决定恢复哪一份内容。"
  case .corrupt: return "草稿文件损坏；原文件已保留，自动保存已暂停。请先备份 drafts.json，再修复或移走该文件并重启应用。"
  case .unsupportedVersion: return "草稿文件版本不受支持；原文件已保留，自动保存已暂停。请使用兼容版本恢复或先备份 drafts.json。"
  case .limit: return "草稿超过安全上限（256 条、256 个工作区、单条 262144 UTF-16 单元、文件 8 MiB，路径和状态另有上限）；未截断内容或覆盖上次保存。请缩短或清理草稿。"
  }
 }
}

/// All mutable state and filesystem operations are confined to queue. Callers submit
/// snapshots in edit order; delayed jobs carry a generation and cannot commit stale data.
public final class DraftPersistence: @unchecked Sendable {
 private let directory: URL
 private let debounce: TimeInterval
 private let queue = DispatchQueue(label: "eve.composer-drafts", qos: .utility)
 private var loaded = false
 private var previousData: Data?
 private var blocked: DraftPersistenceFailure?
 private var pending: DraftSnapshot?
 private var generation: UInt64 = 0
 private var lastFailure: DraftPersistenceFailure?
 private var report: (@Sendable (String) -> Void)?
 public init(directory: URL, debounce: TimeInterval = 0.5) {
  self.directory = directory
  self.debounce = max(0, debounce)
 }
 public static func defaultDirectory(bundleIdentifier: String?, applicationSupport: URL? = nil) throws -> URL {
  guard let id = bundleIdentifier, !id.isEmpty, id != ".", id != "..", id.utf8.count <= 255,
   id.unicodeScalars.allSatisfy({ CharacterSet(charactersIn: "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789.-_").contains($0) }) else { throw DraftPersistenceFailure.location }
  guard let base = applicationSupport ?? FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first else { throw DraftPersistenceFailure.location }
  return base.appendingPathComponent(id, isDirectory: true).appendingPathComponent("ComposerDrafts", isDirectory: true)
 }
 public func load() throws -> DraftSnapshot {
  try queue.sync {
   // A failed read is sticky: a later save must never silently replace that file.
   if let blocked { throw blocked }
   do {
    let dir = try openDirectory(); defer { close(dir) }
    guard let data = try readExistingData(dir) else { previousData = nil; loaded = true; return DraftSnapshot() }
    let snapshot: DraftSnapshot
    do { snapshot = try JSONDecoder().decode(DraftSnapshot.self, from: data) }
    catch { throw DraftPersistenceFailure.corrupt }
    let validated = try snapshot.validated()
    previousData = data
    loaded = true
    return validated
   } catch {
    let failure = error as? DraftPersistenceFailure ?? .io
    blocked = failure
    throw failure
   }
  }
 }
 public func schedule(_ snapshot: DraftSnapshot, onFailure: (@Sendable (String) -> Void)? = nil) {
  queue.async { [self] in
   generation &+= 1
   let expected = generation
   pending = snapshot; report = onFailure
   queue.asyncAfter(deadline: .now() + debounce) { [self] in
    guard expected == generation, pending != nil else { return }
    do { try savePending() }
    catch { report?(safeMessage(error)) }
   }
  }
 }
 public func flush() async throws {
  try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
   queue.async { [self] in
    do { try savePending(); continuation.resume() }
    catch { report?(safeMessage(error)); continuation.resume(throwing: error) }
   }
  }
 }
 private func safeMessage(_ error: Error) -> String {
  (error as? DraftPersistenceFailure ?? .io).localizedDescription
 }
 private func savePending() throws {
  if let blocked { throw blocked }
  guard loaded else { throw DraftPersistenceFailure.io }
  guard let pending else { if let lastFailure { throw lastFailure }; return }
  do {
   let validated = try pending.validated()
   let encoder = JSONEncoder(); encoder.outputFormatting = [.sortedKeys]
   let data = try encoder.encode(validated)
   guard data.count <= DraftSnapshot.maxFileBytes else { throw DraftPersistenceFailure.limit }
   try replace(data)
   self.pending = nil; lastFailure = nil
  } catch {
   let failure = error as? DraftPersistenceFailure ?? .io
   lastFailure = failure
   throw failure
  }
 }
 private func openDirectory() throws -> Int32 {
  guard directory.isFileURL, directory.path.hasPrefix("/"), !directory.path.utf8.contains(0) else { throw DraftPersistenceFailure.unsafePath }
  let components = directory.path.split(separator: "/").map(String.init)
  guard !components.isEmpty, !components.contains(".."), !components.contains(".") else { throw DraftPersistenceFailure.unsafePath }
  var fd = open("/", O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW)
  guard fd >= 0 else { throw DraftPersistenceFailure.io }
  do {
   for component in components {
    var next = openat(fd, component, O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW)
    if next < 0, errno == ENOENT {
     guard mkdirat(fd, component, 0o700) == 0 || errno == EEXIST else { throw DraftPersistenceFailure.io }
     next = openat(fd, component, O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW)
    }
    guard next >= 0 else { throw DraftPersistenceFailure.unsafePath }
    close(fd); fd = next
   }
   var info = stat()
   guard fstat(fd, &info) == 0, info.st_uid == getuid(), fchmod(fd, 0o700) == 0 else { throw DraftPersistenceFailure.unsafePath }
   return fd
  } catch { close(fd); throw error }
 }
 private func openExisting(_ dir: Int32) throws -> Int32? {
  // O_NONBLOCK also avoids hanging on a substituted FIFO before fstat.
  let fd = openat(dir, "drafts.json", O_RDONLY | O_CLOEXEC | O_NOFOLLOW | O_NONBLOCK)
  if fd < 0 { if errno == ENOENT { return nil }; throw DraftPersistenceFailure.unsafePath }
  var info = stat()
  guard fstat(fd, &info) == 0, info.st_mode & S_IFMT == S_IFREG, info.st_uid == getuid(), info.st_nlink == 1 else { close(fd); throw DraftPersistenceFailure.unsafePath }
  guard fchmod(fd, 0o600) == 0 else { close(fd); throw DraftPersistenceFailure.io }
  guard info.st_size <= DraftSnapshot.maxFileBytes else { close(fd); throw DraftPersistenceFailure.limit }
  return fd
 }
 private func readExistingData(_ dir: Int32) throws -> Data? {
  guard let file = try openExisting(dir) else { return nil }
  defer { close(file) }
  var data = Data(); var bytes = [UInt8](repeating: 0, count: 16384)
  while true {
   let count = read(file, &bytes, bytes.count)
   if count < 0 { if errno == EINTR { continue }; throw DraftPersistenceFailure.io }
   if count == 0 { return data }
   guard data.count + count <= DraftSnapshot.maxFileBytes else { throw DraftPersistenceFailure.limit }
   data.append(contentsOf: bytes.prefix(count))
  }
 }
 private func verifyUnchanged(_ dir: Int32) throws {
  guard try readExistingData(dir) == previousData else {
   blocked = .externalChange
   throw DraftPersistenceFailure.externalChange
  }
 }
 private func replace(_ data: Data) throws {
  let dir = try openDirectory(); defer { close(dir) }
  try verifyUnchanged(dir)
  let name = ".drafts-" + UUID().uuidString + ".tmp"
  let fd = openat(dir, name, O_WRONLY | O_CREAT | O_EXCL | O_CLOEXEC | O_NOFOLLOW, 0o600)
  guard fd >= 0 else { throw DraftPersistenceFailure.io }
  defer { close(fd); unlinkat(dir, name, 0) }
  guard fchmod(fd, 0o600) == 0 else { throw DraftPersistenceFailure.io }
  try data.withUnsafeBytes { buffer in
   var offset = 0
   while offset < buffer.count {
    let count = write(fd, buffer.baseAddress!.advanced(by: offset), buffer.count - offset)
    if count < 0, errno == EINTR { continue }
    guard count > 0 else { throw DraftPersistenceFailure.io }
    offset += count
   }
  }
  guard fsync(fd) == 0 else { throw DraftPersistenceFailure.io }
  // Recheck immediately before replacing; rename replaces the directory entry,
  // never follows a link. Descriptor-relative operations keep ancestors anchored.
  try verifyUnchanged(dir)
  guard renameat(dir, name, dir, "drafts.json") == 0 else { throw DraftPersistenceFailure.io }
  previousData = data
  guard fsync(dir) == 0 else { throw DraftPersistenceFailure.io }
 }
}

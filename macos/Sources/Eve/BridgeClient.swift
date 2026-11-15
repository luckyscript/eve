import Foundation
import EveProtocol

struct BridgeFailure: LocalizedError {
 let message: String
 var code: String = "OPERATION"
 var unsupported: Bool { code == "UNSUPPORTED" || code == "UNKNOWN_OPERATION" || message.contains("未知 operation") || message.contains("不支持") || message.contains("参数、配置、预算、锁或运行状态无效") }
 var errorDescription: String? { message }
}

@MainActor final class BridgeClient {
 private var process: Process?
 private var input: FileHandle?
 private var decoder = LineDecoder()
 private var continuations: [String: CheckedContinuation<Data, Error>] = [:]
 private let writer = DispatchQueue(label: "eve.bridge.stdin")
 var awaitingSettlement: Bool { ended && process?.isRunning == true }
 var onEvent: ((String, [String: Any]) -> Void)?
 var onFailure: ((String) -> Void)?
 private var ended = false
 private var generation = UUID()
 private var deadlines: [String: Task<Void, Never>] = [:]

 func start() throws {
  if let process, process.isRunning {
   if ended { throw BridgeFailure(message: "原连接正在等待任务收尾，请稍后重连。", code: "SETTLING") }
   return
  }
  process = nil; input = nil; decoder = LineDecoder(); ended = false
  generation = UUID(); let connectionGeneration = generation
  let resources = Bundle.main.resourceURL
  let bundled = resources?.appendingPathComponent("bridge/Bridge/main.mjs")
  let bridge: URL
  let node: URL
  if let bundled, FileManager.default.fileExists(atPath: bundled.path) {
   bridge = bundled
   node = resources!.appendingPathComponent("runtime/node")
  } else {
   let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
   bridge = root.appendingPathComponent("Bridge/main.mjs")
   node = URL(fileURLWithPath: "/usr/local/bin/node")
  }
  let task = Process(), stdinPipe = Pipe(), stdoutPipe = Pipe(), stderrPipe = Pipe()
  task.executableURL = node
  task.arguments = [bridge.path]
  task.currentDirectoryURL = FileManager.default.homeDirectoryForCurrentUser
  // Do not inherit arbitrary Node loaders, inspectors, logging or prompt audit paths.
  task.environment = ProcessInfo.processInfo.environment.filter { $0.key == "HOME" || $0.key == "TMPDIR" || $0.key == "LANG" || $0.key.hasPrefix("EVE_") }
  task.standardInput = stdinPipe; task.standardOutput = stdoutPipe; task.standardError = stderrPipe
  input = stdinPipe.fileHandleForWriting
  stdoutPipe.fileHandleForReading.readabilityHandler = { [weak self] handle in
   let data = handle.availableData
   Task { @MainActor [weak self] in guard self?.generation == connectionGeneration else { return }; self?.receive(data) }
  }
  // Drain stderr, but never render Node diagnostics that could include private payloads.
  stderrPipe.fileHandleForReading.readabilityHandler = { handle in
   if handle.availableData.isEmpty { handle.readabilityHandler = nil }
  }
  task.terminationHandler = { [weak self] p in
   Task { @MainActor [weak self] in
    guard self?.generation == connectionGeneration else { return }
    self?.fail("Bridge 已退出 (\(p.terminationStatus))。已写入文件未回滚；重新连接后核验原会话。")
   }
  }
  try task.run()
  process = task
 }

 func call(_ op: String, _ params: [String: Any] = [:], id: String = UUID().uuidString, timeout: Double = 20) async throws -> Any {
  if ended { throw BridgeFailure(message: "Bridge 已断开，请重新连接并核验会话。") }
  guard let input else { throw BridgeFailure(message: "Bridge 尚未启动。") }
  var data = try JSONSerialization.data(withJSONObject: ["requestID": id, "op": op, "params": params])
  guard data.count <= 262144 else { throw BridgeFailure(message: "请求超过 256 KiB。") }
  data.append(10)
  let reply: Data = try await withCheckedThrowingContinuation { continuation in
   continuations[id] = continuation
   deadlines[id] = Task { @MainActor [weak self] in
    do { try await Task.sleep(for: .seconds(timeout)) } catch { return }
    guard let self, self.continuations[id] != nil else { return }
    self.fail("操作 \(op) 超时；连接已关闭以请求协作收尾。重新连接后核验会话，不会自动重放。")
   }
   let bytes = data
   writer.async { [weak self] in
    do { try input.write(contentsOf: bytes) }
    catch { Task { @MainActor [weak self] in self?.fail("Bridge 输入管道写入失败；检查任务状态后再试。") } }
   }
  }
  return (try JSONSerialization.jsonObject(with: reply) as? [String: Any])?["value"] ?? NSNull()
 }
 private func receive(_ data: Data) {
  guard !ended else { return }
  do {
   if data.isEmpty { try decoder.finish(); fail("Bridge 输出已关闭。已写入产物未回滚。"); return }
   for frame in try decoder.append(data) {
    guard let id = frame["requestID"] as? String, let type = frame["type"] as? String else { throw ProtocolError.invalid }
    if type == "event", let event = frame["event"] as? [String: Any] { onEvent?(id, event); continue }
    guard let c = continuations.removeValue(forKey: id) else { continue }
    deadlines.removeValue(forKey: id)?.cancel()
    if type == "result" { c.resume(returning: try JSONSerialization.data(withJSONObject: ["value": frame["result"] ?? NSNull()])) }
    else if type == "error" {
     let message = (frame["error"] as? [String: Any])?["message"] as? String ?? "Bridge 操作失败"
     c.resume(throwing: BridgeFailure(message: message, code: (frame["error"] as? [String: Any])?["code"] as? String ?? "OPERATION"))
    } else { c.resume(throwing: ProtocolError.invalid); throw ProtocolError.invalid }
   }
  } catch { fail("Bridge 协议错误或消息超过限制。请检查本地会话，不会自动重放任务。") }
 }
 private func fail(_ message: String) {
  guard !ended else { return }; ended = true
  // EOF lets the host abort and settle writes. Never terminate it mid-write.
  try? input?.close(); input = nil
  deadlines.values.forEach { $0.cancel() }; deadlines.removeAll()
  let waiting = continuations; continuations.removeAll()
  for c in waiting.values { c.resume(throwing: BridgeFailure(message: message, code: "CONNECTION")) }
  onFailure?(message)
 }
}

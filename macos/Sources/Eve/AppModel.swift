import SwiftUI
import AppKit
import EveProtocol

typealias JSONObject = [String: Any]
func object(_ value: Any?) -> JSONObject { value as? JSONObject ?? [:] }
func objects(_ value: Any?) -> [JSONObject] { value as? [JSONObject] ?? [] }
func text(_ value: Any?) -> String { guard let value, !(value is NSNull) else { return "" }; return String(describing: value) }
func pretty(_ value: Any?) -> String {
 guard let value, JSONSerialization.isValidJSONObject(value), let data = try? JSONSerialization.data(withJSONObject: value, options: [.prettyPrinted, .sortedKeys]), let result = String(data: data, encoding: .utf8) else { return text(value) }
 return result
}
enum Page: String, CaseIterable, Identifiable {
 case chat = "聊天与任务", tools = "Tools", skills = "Skills", capabilities = "Capabilities", evolution = "进化", settings = "设置"
 var id: String { rawValue }
 var symbol: String { switch self { case .chat: "bubble.left.and.bubble.right"; case .tools: "wrench.and.screwdriver"; case .skills: "books.vertical"; case .capabilities: "checkmark.shield"; case .evolution: "arrow.triangle.branch"; case .settings: "gearshape" } }
}
@MainActor final class AppModel: ObservableObject {
 let bridge = BridgeClient()
 @Published var workspace = ""
 @Published var page: Page = .chat
 @Published var busy = false
 @Published var connected = false
 @Published var activity = "尚未选择工作区"
 @Published var error: String?
 @Published var sessions: [JSONObject] = []
 @Published var selectedSession = ""
 @Published var runs: [JSONObject] = []
 @Published var events: [JSONObject] = []
 @Published var latest: JSONObject = [:]
 @Published var context: JSONObject = [:]
 @Published var tools: [JSONObject] = []
 @Published var skills: [JSONObject] = []
 @Published var warnings: [String] = []
 @Published var capabilities: JSONObject = [:]
 @Published var experiments: [JSONObject] = []
 @Published var config: JSONObject = [:]
 @Published var configDraft: [String: String] = [:]
 @Published var secret = ""
 @Published var prompt = ""
 @Published var contractFile = ""
 @Published var contractState = "未选择 · 不进行独立验收"
 @Published var suiteFile = ""
 @Published var suiteState = "未选择 suite"
 @Published var sourceSession = ""
 @Published var sourceRun = ""
 @Published var sourceRuns: [JSONObject] = []
 @Published var skill = ""
 @Published var correction = ""
 @Published var maxRequests = "30"
 @Published var evolutionTimeout = "600000"
 @Published var autoPromote = true
 @Published var autoEvolve = false
 @Published var evolutionResult: JSONObject = [:]
 @Published var cancelRequested = false
 private var activeID: String?
 private var configBaseline: [String: String] = [:]

 init() {
  bridge.onEvent = { [weak self] id, event in
   guard let self, id == self.activeID else { return }
   self.events.append(event)
   if self.events.count > 2000 { self.events.removeFirst(self.events.count - 2000) }
   self.activity = text(event["type"]) + " " + text(event["name"])
  }
  bridge.onFailure = { [weak self] message in self?.connected = false; self?.error = message }
  do { try bridge.start(); connected = true }
  catch { self.error = "无法启动固定 Node bridge：\(error.localizedDescription)" }
 }
 func restore() {
  guard workspace.isEmpty, let last = UserDefaults.standard.string(forKey: "workspace"), FileManager.default.fileExists(atPath: last) else { return }
  setWorkspace(last)
 }
 func chooseWorkspace() { if let file = pick(directory: true) { setWorkspace(file) } }
 func pick(directory: Bool = false) -> String? {
  let panel = NSOpenPanel(); panel.canChooseDirectories = directory; panel.canChooseFiles = !directory; panel.allowsMultipleSelection = false
  panel.prompt = directory ? "使用工作区" : "选择文件"
  return panel.runModal() == .OK ? panel.url?.path : nil
 }
 func perform(_ name: String, _ body: @escaping @MainActor () async throws -> Void) {
  guard !busy, connected else { return }
  busy = true; cancelRequested = false; activity = name; error = nil
  Task { @MainActor in
   do { try await body() }
   catch { self.error = error.localizedDescription }
   self.busy = false; self.activeID = nil
   self.activity = self.error == nil ? "就绪" : "操作失败 · 查看错误"
  }
 }
 func call(_ op: String, _ params: JSONObject = [:]) async throws -> Any {
  let id = UUID().uuidString; activeID = id
  return try await bridge.call(op, params, id: id)
 }
 func setWorkspace(_ path: String) {
  perform("打开工作区") {
   let result = object(try await self.call("workspace", ["path": path]))
   self.workspace = text(result["path"]); UserDefaults.standard.set(self.workspace, forKey: "workspace")
   self.selectedSession = ""; self.runs = []; self.latest = [:]; self.events = []; self.context = [:]
   self.sourceSession = ""; self.sourceRun = ""; self.sourceRuns = []; self.contractFile = ""; self.suiteFile = ""; self.autoEvolve = false
   self.contractState = "未选择 · 不进行独立验收"; self.suiteState = "未选择 suite"
   try await self.refreshAll()
  }
 }
 func refreshAll() async throws {
  sessions = objects(try await call("sessions"))
  config = object(try await call("config")); updateDraft()
  tools = objects(try await call("tools"))
  let s = object(try await call("skills")); skills = objects(s["skills"]); warnings = s["warnings"] as? [String] ?? []
  capabilities = object(try await call("capabilities")); experiments = objects(try await call("experiments"))
 }
 func refresh() { perform("刷新") { try await self.refreshAll() } }
 func updateDraft() {
  configDraft = config.filter { $0.key != "apiKey" }.mapValues { $0 is [String] ? ($0 as! [String]).joined(separator: "\n") : text($0) }
  configBaseline = configDraft
 }
 func newSession() { guard !busy else { return }; selectedSession = ""; runs = []; events = []; latest = [:]; context = [:]; page = .chat }
 func resume(_ id: String) {
  perform("恢复会话") {
   let data = object(try await self.call("session", ["sessionId": id])); self.runs = objects(data["runs"])
   self.selectedSession = id; self.latest = self.runs.last ?? [:]; self.events = []; self.page = .chat
   self.context = object(try await self.call("status", ["sessionId": id]))
  }
 }
 func validateFile(suite: Bool) {
  guard let file = pick() else { return }
  perform(suite ? "验证 suite" : "验证契约") {
   let result = object(try await self.call(suite ? "suite" : "contract", ["file": file]))
   if suite { self.suiteFile = file; self.suiteState = "有效 · \(text(result["cases"])) cases · 请求上限 \(text(result["requestCeiling"]))" }
   else { self.contractFile = file; self.contractState = "有效 · \(text(result["assertions"])) 项断言" }
  }
 }
 func evolutionOptions() throws -> JSONObject {
  guard let budget = Int(maxRequests), (1...100).contains(budget), let timeout = Int(evolutionTimeout), (1...1800000).contains(timeout), !skill.isEmpty, !suiteFile.isEmpty else { throw BridgeFailure(message: "进化需要 skill、suite、显式请求预算 1–100 和 timeout 1–1800000 ms。") }
  return ["skill": skill, "suiteFile": suiteFile, "correction": correction, "maxRequests": budget, "timeoutMs": timeout, "autoPromote": autoPromote]
 }
 func submit() {
  let task = prompt.trimmingCharacters(in: .whitespacesAndNewlines); guard !task.isEmpty else { return }
  perform("运行任务") {
   var params: JSONObject = ["prompt": task]
   if !self.selectedSession.isEmpty { params["sessionId"] = self.selectedSession }
   if !self.contractFile.isEmpty { params["contractFile"] = self.contractFile }
   if self.autoEvolve { params.merge(try self.evolutionOptions()) { _, new in new }; params["autoEvolve"] = true }
   self.events = []; self.latest = ["prompt": task, "status": "running", "modelStatus": "running", "verification": ["status": "pending"]]
   let result = object(try await self.call("run", params))
   self.latest = result; self.selectedSession = text(result["sessionId"]); self.context = object(result["context"])
   self.evolutionResult = object(result["evolution"]); self.prompt = ""
   self.runs = objects(object(try await self.call("session", ["sessionId": self.selectedSession]))["runs"])
   try await self.refreshAll()
  }
 }
 func cancel() {
  guard let activeID, busy, !cancelRequested else { return }; cancelRequested = true
  Task { @MainActor in
   do { _ = try await bridge.call("cancel", ["requestID": activeID]) }
   catch { self.error = error.localizedDescription }
  }
 }
 func status() { guard !selectedSession.isEmpty else { return }; perform("读取状态") { self.context = object(try await self.call("status", ["sessionId": self.selectedSession])) } }
 func compact() {
  guard !selectedSession.isEmpty else { return }
  perform("压缩上下文") {
   let r = object(try await self.call("compact", ["sessionId": self.selectedSession])); self.context = object(r["context"])
   if text(r["status"]) != "completed" { throw BridgeFailure(message: "压缩未完成：\(text(object(r["error"])["message"]))") }
  }
 }
 func saveSettings() {
  perform("保存本地配置") {
   let patch = try ConfigurationPatch.make(baseline: self.configBaseline, draft: self.configDraft)
   let values = object(try JSONSerialization.jsonObject(with: patch))
   guard !values.isEmpty else { return }
   _ = try await self.call("configure", ["values": values]); self.config = object(try await self.call("config")); self.updateDraft()
  }
 }
 func saveSecret() {
  let value = secret; secret = ""
  guard !value.isEmpty else { return }
  perform("安全保存密钥") { _ = try await self.call("secret", ["value": value]); self.config = object(try await self.call("config")) }
 }
 func importSkill() { guard let file = pick() else { return }; perform("导入可信基线") { _ = try await self.call("import", ["file": file]); try await self.refreshAll() } }
 func promote(_ id: String) { perform("发布候选") { self.evolutionResult = object(try await self.call("promote", ["id": id])); try await self.refreshAll() } }
 func rollback(_ name: String) { perform("回滚技能") { self.evolutionResult = object(try await self.call("rollback", ["name": name])); try await self.refreshAll() } }
 func loadSource(_ id: String) {
  sourceSession = id; sourceRun = ""; sourceRuns = []
  guard !id.isEmpty else { return }
  perform("读取进化来源") { self.sourceRuns = objects(object(try await self.call("session", ["sessionId": id]))["runs"]); self.sourceRun = self.sourceRuns.last.map { text($0["id"]) } ?? "" }
 }
 func evolve() {
  perform("生成与对照评测") {
   guard !self.sourceSession.isEmpty, !self.sourceRun.isEmpty else { throw BridgeFailure(message: "请选择来源会话和运行。来源必须有真实契约失败并已加载当前基线。") }
   var params = try self.evolutionOptions(); params["sessionId"] = self.sourceSession; params["runId"] = self.sourceRun
   do { self.evolutionResult = object(try await self.call("evolve", params)) }
   catch { self.evolutionResult = ["status": "failed", "error": "生成、评测或发布失败；实验记录显示实际状态。"]; self.experiments = objects(try await self.call("experiments")); throw error }
   try await self.refreshAll()
  }
 }
}

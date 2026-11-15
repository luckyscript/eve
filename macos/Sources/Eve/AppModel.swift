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
 case chat = "聊天与任务", tools = "Tools", skills = "Skills", capabilities = "Capabilities", evolution = "进化", remote = "远程访问", settings = "设置"
 var id: String { rawValue }
 var symbol: String { switch self { case .chat: "bubble.left.and.bubble.right"; case .tools: "wrench.and.screwdriver"; case .skills: "books.vertical"; case .capabilities: "checkmark.shield"; case .evolution: "arrow.triangle.branch"; case .remote: "network"; case .settings: "gearshape" } }
}
@MainActor final class AppModel: ObservableObject {
 let bridge = BridgeClient()
 @Published var workspace = ""
 @Published var page: Page = .chat
 @Published var busy = false
 @Published var connected = false
 @Published var activity = "尚未选择工作区"
 @Published var error: String? {
  didSet { if error == nil, let draftPersistenceNotice { error = draftPersistenceNotice } }
 }
 @Published var sessions: [JSONObject] = []
 @Published var selectedSession = ""
 @Published var sessionTitles: [String: String] = [:]
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
 @Published var prompt = "" { didSet { storeDraft() } }
 @Published var contractFile = "" { didSet { storeDraft() } }
 @Published var contractState = "未选择 · 不进行独立验收" { didSet { storeDraft() } }
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
 @Published var autoEvolve = false { didSet { storeDraft() } }
 @Published var evolutionResult: JSONObject = [:]
 @Published var cancelRequested = false
 @Published var isRunning = false
 @Published var cancelState = ""
 @Published var focusToken = 0
 @Published var runningOrigin: ConversationKey?
 @Published var errorCode = ""
 @Published var settingsFeedback = ""
 @Published var configDiagnostics: [JSONObject] = []
 @Published var configSources: JSONObject = [:]
 @Published var configurationValid = true
 @Published var connectionResult: JSONObject = [:]
 @Published var availableModels: [String] = []
 @Published var sessionQuery = ""
 @Published var includeArchived = false
 @Published var historyHasMore = false
 @Published var historyNotice = ""
 @Published private var historyLoads: Set<ConversationKey> = []
 var loadingCurrentHistory: Bool { historyLoads.contains(conversationKey) }
 var canLoadHistory: Bool { !loadingCurrentHistory && (!busy || (isRunning && !showingRunning && bridgeWorkspace == workspace)) }
 private var historyCursors: [ConversationKey: String] = [:]
 private var historyMore: [ConversationKey: Bool] = [:]
 @Published private(set) var draftPersistenceNotice: String?
 private var draftPersistence: DraftPersistence?
 private var draftRecoveryLocation = ""
 private var draftPersistenceReady = false
 private var workspaceDraftIDs: [String: String] = [:] { didSet { persistDrafts() } }
 private var draftID = "s-" + UUID().uuidString.lowercased()
 private var restoringDraft = false
 private var drafts = ConversationDrafts() { didSet { persistDrafts() } }
 private var localFailures: [ConversationKey: [JSONObject]] = [:]
 private var cachedRuns: [ConversationKey: [JSONObject]] = [:]
 private var workspaceSessions: [String: [JSONObject]] = [:]
 private var bridgeWorkspace = ""
 private var activeID: String?
 private var activeEvents: [JSONObject] = []
 private var activeRun: JSONObject = [:]
 private var runOrigin: ConversationKey?
 private var interruptedOrigin: ConversationKey?
 var conversationKey: ConversationKey { ConversationKey(workspace: workspace, session: selectedSession.isEmpty ? draftID : selectedSession) }
 var showingRunning: Bool { runOrigin == conversationKey }
 var settingsDirty: Bool { configDraft != configBaseline }
 private func storeDraft() {
  guard !restoringDraft else { return }
  var draft = ConversationDraft(); draft.prompt = prompt; draft.contract = contractFile; draft.contractState = contractState; draft.autoEvolve = autoEvolve
  if selectedSession.isEmpty, workspaceDraftIDs[workspace] != draftID { workspaceDraftIDs[workspace] = draftID }
  drafts[conversationKey] = draft
 }
 private func persistDrafts() {
  guard draftPersistenceReady, let draftPersistence else { return }
  draftPersistence.schedule(DraftSnapshot(drafts: drafts, workspaceDraftIDs: workspaceDraftIDs)) { [weak self] message in
   Task { @MainActor [weak self] in self?.reportDraftFailure(message) }
  }
 }
 private func reportDraftFailure(_ message: String) {
  let location = draftRecoveryLocation.isEmpty ? "" : " 文件位置：" + draftRecoveryLocation
  let notice = "草稿未安全保存：" + message + " 当前编辑仍在内存中；请勿强制退出。" + location
  draftPersistenceNotice = notice
  error = notice; errorCode = "DRAFT_PERSISTENCE"
 }
 /// Called only on actual termination, after the existing shutdown guards settle.
 func flushDrafts() async -> Bool {
  storeDraft()
  guard let draftPersistence else {
   reportDraftFailure(DraftPersistenceFailure.location.localizedDescription)
   return false
  }
  do {
   try await draftPersistence.flush()
   let previousNotice = draftPersistenceNotice
   draftPersistenceNotice = nil
   if let previousNotice, error == previousNotice { error = nil; errorCode = "" }
   return true
  } catch {
   reportDraftFailure((error as? DraftPersistenceFailure ?? .io).localizedDescription)
   return false
  }
 }
 private func restoreDraft() {
  restoringDraft = true
  let draft = drafts[conversationKey] ?? ConversationDraft()
  prompt = draft.prompt; contractFile = draft.contract; contractState = draft.contractState; autoEvolve = draft.autoEvolve
  restoringDraft = false; focusToken += 1
 }
 private func showCached() {
  runs = cachedRuns[conversationKey] ?? []; latest = showingRunning ? activeRun : [:]
  events = showingRunning ? activeEvents : []; context = [:]
  historyHasMore = historyMore[conversationKey] ?? false; historyNotice = ""
 }

 private var configBaseline: [String: String] = [:]

 init(draftDirectory: URL? = nil) {
  // Load before bridge startup or workspace restoration; never inspect sessions.
  do {
   let directory = try draftDirectory ?? DraftPersistence.defaultDirectory(bundleIdentifier: Bundle.main.bundleIdentifier)
   draftRecoveryLocation = directory.appendingPathComponent("drafts.json").path
   let persistence = DraftPersistence(directory: directory)
   draftPersistence = persistence
   let snapshot = try persistence.load()
   drafts = snapshot.drafts; workspaceDraftIDs = snapshot.workspaceDraftIDs
   draftID = workspaceDraftIDs[workspace] ?? draftID
   restoreDraft()
  } catch {
   reportDraftFailure((error as? DraftPersistenceFailure ?? .io).localizedDescription)
  }
  draftPersistenceReady = true
  bridge.onEvent = { [weak self] id, event in
   guard let self, id == self.activeID else { return }
   self.activeEvents.append(event)
   if self.activeEvents.count > 2000 { self.activeEvents.removeFirst(self.activeEvents.count - 2000) }
   if text(event["type"]) == "assistant_delta" { self.activeRun["final"] = text(self.activeRun["final"]) + text(event["text"]) }
   if text(event["type"]) == "run.failed" {
    self.activeRun["error"] = event["error"] ?? ["message": text(event["message"]).nonEmpty(or: "运行失败，请检查任务时间线及配置。")]
   }
   if self.showingRunning { self.events = self.activeEvents; self.latest = self.activeRun }
   else if self.runOrigin == nil { self.events = self.activeEvents }
   if self.cancelRequested { self.cancelState = "正在收尾，等待文件写入完成" }
   self.activity = text(event["type"]) + " " + text(event["name"])
  }
  bridge.onFailure = { [weak self] message in self?.connected = false; self?.error = message; self?.errorCode = "CONNECTION"; self?.bridgeWorkspace = "" }
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
  let operationWorkspace = workspace
  busy = true; cancelRequested = false; activity = name; error = nil; errorCode = ""
  Task { @MainActor in
   do { try await body() }
   catch { self.error = error.localizedDescription; self.errorCode = (error as? BridgeFailure)?.code ?? "VALIDATION" }
   self.busy = false; self.activeID = nil; self.isRunning = false
   self.activity = self.error == nil ? "就绪" : "操作失败 · 查看错误"
   if self.workspace != operationWorkspace, self.connected { self.openWorkspace() }
  }
 }
 func call(_ op: String, _ params: JSONObject = [:], expectedWorkspace: String? = nil) async throws -> Any {
  if !WorkspaceRouting.allows(op: op, connected: bridgeWorkspace, browsing: workspace, expected: expectedWorkspace) {
   throw BridgeFailure(message: "此工作区尚未连接宿主。可继续浏览缓存和编辑草稿；请等待原任务收尾，再刷新或重新连接。", code: "WORKSPACE_NOT_READY")
  }
  let id = UUID().uuidString
  let writing = ["evolve", "compact", "promote", "rollback", "import", "configure", "secret", "config.repair", "session.rename", "session.archive", "session.delete"].contains(op)
  if writing { activeID = id; isRunning = true; activeEvents = []; events = [] }
  defer { if writing, activeID == id { activeID = nil; isRunning = false } }
  let timeout = BridgeTimeout.seconds(op: op, timeoutMs: Double(text(config["timeoutMs"])) ?? 90000, steps: Double(text(config["maxSteps"])) ?? 12, evolutionMs: Double(text(params["timeoutMs"])) ?? 0)
  let result = try await bridge.call(op, params, id: id, timeout: timeout)
  if op == "workspace" { bridgeWorkspace = text(object(result)["path"]) }
  return result
 }
 func setWorkspace(_ requestedPath: String) {
  let path = URL(fileURLWithPath: requestedPath).resolvingSymlinksInPath().path
  guard path != workspace, !busy || runOrigin != nil else { return }
  if settingsDirty {
   let alert = NSAlert(); alert.messageText = "当前工作区有未保存的设置"; alert.informativeText = "返回设置保存后再切换，或放弃这些设置编辑。"; alert.addButton(withTitle: "返回设置"); alert.addButton(withTitle: "放弃并切换")
   if alert.runModal() == .alertFirstButtonReturn { page = .settings; return }
  }
  storeDraft(); workspaceDraftIDs[workspace] = draftID; workspaceSessions[workspace] = sessions
  workspace = path; UserDefaults.standard.set(path, forKey: "workspace")
  selectedSession = ""; draftID = workspaceDraftIDs[path] ?? ("s-" + UUID().uuidString.lowercased())
  sessionTitles = [:]; sessions = workspaceSessions[path] ?? []
  for session in sessions { sessionTitles[text(session["id"])] = text(session["title"]) }
  skill = ""; correction = ""; secret = ""; evolutionResult = [:]
  sourceSession = ""; sourceRun = ""; sourceRuns = []; suiteFile = ""; suiteState = "未选择 suite"
  config = [:]; configDraft = [:]; configBaseline = [:]; configSources = [:]; configDiagnostics = []; connectionResult = [:]; availableModels = []
  tools = []; skills = []; warnings = []; capabilities = [:]; experiments = []
  restoreDraft(); showCached()
  guard !busy else { activity = "运行仍归属原工作区；当前可查看缓存并草拟"; return }
  openWorkspace()
 }
 private func openWorkspace() {
  let path = workspace
  perform("打开工作区") {
   let result = object(try await self.call("workspace", ["path": path]))
   guard self.workspace == path else { return }
   self.workspace = text(result["path"]).isEmpty ? path : text(result["path"])
   if let problem = result["configurationError"] { self.error = "工作区配置需要修复：" + text(object(problem)["message"]).nonEmpty(or: text(problem)); self.page = .settings }
   try await self.refreshAll()
  }
 }
 func refreshAll() async throws {
  let path = workspace
  sessions = objects(try await call("sessions", sessionSearchParams))
  guard workspace == path else { return }
  workspaceSessions[path] = sessions
  for session in sessions { sessionTitles[text(session["id"])] = text(session["title"]).nonEmpty(or: "未命名会话") }
  try await readConfiguration()
  if !settingsDirty { updateDraft() }
  guard configurationValid else { page = .settings; return }
  tools = objects(try await call("tools"))
  let s = object(try await call("skills")); skills = objects(s["skills"]); warnings = s["warnings"] as? [String] ?? []
  capabilities = object(try await call("capabilities")); experiments = objects(try await call("experiments"))
 }
 private func readConfiguration() async throws {
  do {
   let inspection = object(try await call("config.inspect"))
   config = object(inspection["config"]); configurationValid = inspection["valid"] as? Bool ?? true
   configDiagnostics = objects(inspection["diagnostics"]); configSources = object(inspection["sources"])
  } catch let failure as BridgeFailure where failure.unsupported {
   config = object(try await call("config")); configurationValid = true; configDiagnostics = []; configSources = [:]
  }
 }
 var sessionSearchParams: JSONObject {
  var params: JSONObject = [:]
  if !sessionQuery.isEmpty { params["query"] = sessionQuery }
  if includeArchived { params["includeArchived"] = true }
  return params
 }
 func searchSessions() {
  guard !workspace.isEmpty, !busy else { return }
  perform("搜索会话正文") {
   self.sessions = objects(try await self.call("sessions", self.sessionSearchParams))
   for session in self.sessions { self.sessionTitles[text(session["id"])] = text(session["title"]).nonEmpty(or: "未命名会话") }
  }
 }
 func sessionTitle(_ id: String) -> String { sessionTitles[id] ?? "未命名会话" }
 var chatTitle: String { selectedSession.isEmpty ? "新会话" : sessionTitle(selectedSession) }
 func refresh() { if bridgeWorkspace != workspace { openWorkspace() } else { perform("刷新") { try await self.refreshAll() } } }
 func updateDraft() {
  configDraft = config.filter { $0.key != "apiKey" }.mapValues { $0 is [String] ? ($0 as! [String]).joined(separator: "\n") : text($0) }
  configBaseline = configDraft
 }
 func newSession() {
  storeDraft(); selectedSession = ""; draftID = "s-" + UUID().uuidString.lowercased()
  restoreDraft(); showCached(); page = .chat
 }
 var draftConversations: [ConversationKey] {
  drafts.keys.filter { $0.workspace == workspace && $0 != runningOrigin && !(drafts[$0]?.prompt.isEmpty ?? true) }.sorted { $0.session < $1.session }
 }
 func draftTitle(_ key: ConversationKey) -> String { SessionPresentation.title(prompt: drafts[key]?.prompt ?? "") }
 func resumeDraft(_ key: ConversationKey) {
  guard key.workspace == workspace else { return }
  // After a restart the draft exists on disk, but the history cache is empty.
  // Reuse normal navigation so an existing conversation never looks brand new.
  if sessions.contains(where: { text($0["id"]) == key.session }) { resume(key.session); return }
  storeDraft()
  if cachedRuns[key] != nil || sessions.contains(where: { text($0["id"]) == key.session }) { selectedSession = key.session }
  else { selectedSession = ""; draftID = key.session }
  restoreDraft(); showCached(); page = .chat
 }
 func resume(_ id: String) {
  storeDraft(); selectedSession = id; restoreDraft(); showCached(); page = .chat
  guard !busy else {
   if isRunning && !showingRunning && bridgeWorkspace == workspace { browseHistory(id, older: false) }
   else if runs.isEmpty && !showingRunning { historyNotice = "此工作区尚未连接；当前任务收尾后可加载历史。" }
   return
  }
  historyNotice = ""
  perform("读取会话") { try await self.loadHistory(id, older: false) }
 }
 private func browseHistory(_ id: String, older: Bool) {
  let key = ConversationKey(workspace: workspace, session: id)
  guard !historyLoads.contains(key) else { return }
  historyLoads.insert(key); historyNotice = "正在加载会话历史…"
  Task { @MainActor in
   defer { self.historyLoads.remove(key) }
   do {
    try await self.loadHistory(id, older: older, workspacePath: key.workspace)
    if self.conversationKey == key && !self.historyNotice.contains("截断") { self.historyNotice = "" }
   } catch {
    if self.conversationKey == key { self.historyNotice = "历史未能加载：\(error.localizedDescription)" }
   }
  }
 }
 func returnToRunning() {
  guard let origin = runOrigin else { return }
  if workspace != origin.workspace { setWorkspace(origin.workspace) }
  guard workspace == origin.workspace else { return }
  resume(origin.session)
 }
 private func loadHistory(_ id: String, older: Bool, workspacePath: String? = nil) async throws {
  let key = ConversationKey(workspace: workspacePath ?? workspace, session: id)
  var params: JSONObject = ["sessionId": id, "limit": 20]
  if older, let cursor = historyCursors[key] { params["cursor"] = cursor }
  let data: JSONObject
  do { data = object(try await call("session.page", params, expectedWorkspace: key.workspace)) }
  catch let failure as BridgeFailure where failure.unsupported {
   // Old hosts have no paging. A single explicit history read preserves compatibility.
   data = object(try await call("session", ["sessionId": id], expectedWorkspace: key.workspace))
  }
  let loaded = objects(data["runs"])
  let combined = older ? loaded + (cachedRuns[key] ?? []) : loaded
  let knownIDs = Set(combined.map { text($0["id"]) })
  cachedRuns[key] = combined + (localFailures[key] ?? []).filter { !knownIDs.contains(text($0["id"])) }
  historyCursors[key] = data["nextCursor"] as? String; historyMore[key] = data["hasMore"] as? Bool ?? false
  if conversationKey == key {
   runs = cachedRuns[key] ?? []; latest = [:]; historyHasMore = historyMore[key] ?? false
   if data["truncated"] as? Bool == true { historyNotice = "历史已按宿主字节预算截断；可继续加载较早记录。" }
  }
 }
 func loadOlderHistory() {
  guard canLoadHistory, !selectedSession.isEmpty else { return }
  let id = selectedSession
  if busy { browseHistory(id, older: true) }
  else { perform("加载较早历史") { try await self.loadHistory(id, older: true) } }
 }
 func validateFile(suite: Bool) {
  guard let file = pick() else { return }
  let origin = conversationKey
  perform(suite ? "验证 suite" : "验证契约") {
   let result = object(try await self.call(suite ? "suite" : "contract", ["file": file]))
   if suite { self.suiteFile = file; self.suiteState = "有效 · \(text(result["cases"])) cases · 请求上限 \(text(result["requestCeiling"]))" }
   else {
    let state = "有效 · \(text(result["assertions"])) 项断言"
    if self.conversationKey == origin { self.contractFile = file; self.contractState = state }
    else { var draft = self.drafts[origin] ?? ConversationDraft(); draft.contract = file; draft.contractState = state; self.drafts[origin] = draft }
   }
  }
 }
 func evolutionOptions() throws -> JSONObject {
  guard let budget = Int(maxRequests), (1...100).contains(budget), let timeout = Int(evolutionTimeout), (1...1800000).contains(timeout), !skill.isEmpty, !suiteFile.isEmpty else { throw BridgeFailure(message: "进化需要 skill、suite、显式请求预算 1–100 和 timeout 1–1800000 ms。") }
  return ["skill": skill, "suiteFile": suiteFile, "correction": correction, "maxRequests": budget, "timeoutMs": timeout, "autoPromote": autoPromote]
 }
 func submit() {
  guard !busy, connected, !workspace.isEmpty else { return }
  guard !loadingCurrentHistory else { error = "正在载入这个会话的历史，请稍候再发送。草稿已保留。"; return }
  guard bridgeWorkspace == workspace else { error = "当前工作区尚未连接，请刷新工作区或重新连接后再运行。"; errorCode = "WORKSPACE_NOT_READY"; return }
  guard configurationValid else { error = "工作区配置无效，请先在设置中修复。"; errorCode = "CONFIG"; page = .settings; return }
  if let invalid = ComposerPolicy.validation(prompt) { error = invalid; return }
  storeDraft()
  let origin = conversationKey, submitted = prompt, task = prompt.trimmingCharacters(in: .whitespacesAndNewlines)
  var params: JSONObject = ["prompt": task, "sessionId": origin.session, "stream": true]
  if !contractFile.isEmpty { params["contractFile"] = contractFile }
  do { if autoEvolve { params.merge(try evolutionOptions()) { _, new in new }; params["autoEvolve"] = true } }
  catch { self.error = error.localizedDescription; return }
  selectedSession = origin.session
  if draftID == origin.session { draftID = "s-" + UUID().uuidString.lowercased(); workspaceDraftIDs[workspace] = draftID }
  let submissionID = UUID().uuidString
  activeRun = ["id": submissionID, "prompt": task, "status": "running", "modelStatus": "running", "verification": ["status": "pending"]]
  activeEvents = []; events = []; latest = activeRun
  runOrigin = origin; runningOrigin = origin; isRunning = true; busy = true
  cancelRequested = false; cancelState = ""; error = nil; activity = "运行任务"
  let requestID = UUID().uuidString; activeID = requestID
  let timeout = BridgeTimeout.seconds(op: "run", timeoutMs: Double(text(config["timeoutMs"])) ?? 90000, steps: Double(text(config["maxSteps"])) ?? 12, evolutionMs: autoEvolve ? (Double(evolutionTimeout) ?? 600000) : 0)
  Task { @MainActor in
   var result: JSONObject
   var receivedResult = false
   do {
    result = object(try await self.bridge.call("run", params, id: requestID, timeout: timeout))
    receivedResult = true
    let failed = ["failed", "interrupted", "cancelled"].contains(text(result["status"]))
    self.drafts.complete(origin, submitted: submitted, succeeded: !failed)
   } catch {
    result = self.activeRun; result["status"] = "failed"; result["modelStatus"] = "unknown"
    result["error"] = ["code": (error as? BridgeFailure)?.code ?? "OPERATION", "message": error.localizedDescription + " 可恢复草稿；重新连接后先核验原会话，不会自动重放。"]
    result["localFailure"] = true
    self.localFailures[origin, default: []].append(result)
    self.error = error.localizedDescription; self.errorCode = (error as? BridgeFailure)?.code ?? "OPERATION"; self.interruptedOrigin = origin
   }
   self.cachedRuns[origin, default: []].append(result)
   if self.conversationKey == origin {
    self.runs = self.cachedRuns[origin] ?? []; self.latest = [:]; self.context = object(result["context"])
    self.evolutionResult = object(result["evolution"])
    // Preserve any typing performed while the operation was in flight.
    self.restoreDraft()
   }
   self.activeRun = [:]; self.activeID = nil; self.runOrigin = nil; self.runningOrigin = nil
   self.isRunning = false; self.busy = false; self.cancelRequested = false
   self.cancelState = ""; self.activity = "任务已收尾"
   if self.connected {
    if self.workspace != origin.workspace { self.openWorkspace() }
    else {
     self.perform("更新会话列表") {
      try await self.refreshAll()
      if receivedResult, self.conversationKey == origin { try await self.loadHistory(origin.session, older: false) }
     }
    }
   }
  }
 }
 func cancel() {
  guard let activeID, isRunning, !cancelRequested else { return }
  cancelRequested = true; cancelState = "正在请求取消…"
  Task { @MainActor in
   do {
    let result = object(try await self.bridge.call("cancel", ["requestID": activeID]))
    guard self.isRunning, self.activeID == activeID else { return }
    if result["requested"] as? Bool == true { self.cancelState = "已请求取消，等待运行收尾" }
    else { self.cancelState = "取消未命中；请核验原会话或重试"; self.cancelRequested = false }
   } catch { self.cancelRequested = false; self.cancelState = "取消失败，可重试"; self.error = error.localizedDescription }
  }
 }
 func reconnect() {
  guard !busy else { return }
  do { try bridge.start(); connected = true }
  catch { self.error = error.localizedDescription; return }
  let origin = interruptedOrigin
  perform("重新连接并核验会话") {
   let path = origin?.workspace ?? self.workspace
   guard !path.isEmpty else { return }
   _ = try await self.call("workspace", ["path": path])
   if let origin {
    try await self.loadHistory(origin.session, older: false, workspacePath: origin.workspace)
    if self.conversationKey == origin { self.showCached() }
    self.settingsFeedback = "已重新连接并读取原会话；请核对实际运行历史后再重试"
    self.interruptedOrigin = nil
   }
   if path != self.workspace { _ = try await self.call("workspace", ["path": self.workspace]) }
   try await self.refreshAll()
  }
 }
 func status() {
  guard !selectedSession.isEmpty else { return }
  let origin = conversationKey
  perform("读取状态") {
   let context = object(try await self.call("status", ["sessionId": origin.session]))
   if self.conversationKey == origin { self.context = context }
  }
 }
 func compact() {
  guard !selectedSession.isEmpty else { return }
  let origin = conversationKey
  perform("压缩上下文") {
   let r = object(try await self.call("compact", ["sessionId": origin.session])); if self.conversationKey == origin { self.context = object(r["context"]) }
   if text(r["status"]) != "completed" { throw BridgeFailure(message: "压缩未完成：\(text(object(r["error"])["message"]))") }
  }
 }
 func saveSettings() {
  let submitted = configDraft
  perform("保存本地配置") {
   let patch = try ConfigurationPatch.make(baseline: self.configBaseline, draft: submitted)
   let values = object(try JSONSerialization.jsonObject(with: patch))
   guard !values.isEmpty else { return }
   _ = try await self.call("configure", ["values": values])
   try await self.readConfiguration()
   let editsDuringSave = self.configDraft.filter { submitted[$0.key] != $0.value }
   self.updateDraft()
   self.configDraft.merge(editsDuringSave) { _, edited in edited }
   self.settingsFeedback = editsDuringSave.isEmpty ? "配置已保存 · 有效值已更新" : "配置已保存；保存期间的新编辑仍在草稿中"
  }
 }
 func saveSecret() {
  let value = secret
  guard !value.isEmpty else { return }
  perform("安全保存密钥") { _ = try await self.call("secret", ["value": value]); if self.secret == value { self.secret = "" }; try await self.readConfiguration(); self.settingsFeedback = "密钥已安全保存" }
 }
 func testConnection() {
  perform("测试模型连接") {
   self.connectionResult = object(try await self.call("connection.test"))
   self.availableModels = objects(self.connectionResult["models"]).map { text($0["id"]) }
   if self.connectionResult["ok"] as? Bool != true {
    let failure = object(self.connectionResult["error"])
    self.errorCode = text(failure["code"]); self.error = text(failure["message"]).nonEmpty(or: "连接测试失败，请检查 URL、密钥与网络。")
   }
  }
 }
 func repairSettings() {
  let alert = NSAlert(); alert.messageText = "备份并修复本地配置？"; alert.informativeText = "宿主会备份损坏的本地文件，再写入当前表单值。全局配置、环境变量和安全边界保持由宿主验证。"; alert.addButton(withTitle: "备份并修复"); alert.addButton(withTitle: "取消")
  guard alert.runModal() == .alertFirstButtonReturn else { return }
  perform("修复本地配置") {
   let values = object(try JSONSerialization.jsonObject(with: ConfigurationPatch.make(baseline: [:], draft: self.configDraft)))
   _ = try await self.call("config.repair", ["values": values, "confirm": true])
   self.configBaseline = self.configDraft
   try await self.refreshAll(); self.settingsFeedback = "本地配置已修复，坏文件已由宿主备份"
  }
 }
 func renameSession(_ id: String) {
  let alert = NSAlert(); alert.messageText = "重命名会话"; alert.addButton(withTitle: "保存"); alert.addButton(withTitle: "取消")
  let field = NSTextField(string: sessionTitle(id)); field.frame = NSRect(x: 0, y: 0, width: 300, height: 26); alert.accessoryView = field
  guard alert.runModal() == .alertFirstButtonReturn, !field.stringValue.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return }
  let title = field.stringValue
  perform("重命名会话") { _ = try await self.call("session.rename", ["sessionId": id, "title": title]); try await self.refreshAll() }
 }
 func archiveSession(_ id: String, archived: Bool) {
  let alert = NSAlert(); alert.messageText = archived ? "归档此会话？" : "恢复此归档会话？"; alert.informativeText = "历史内容会保留。可通过显示归档会话再次访问。"; alert.addButton(withTitle: "确认"); alert.addButton(withTitle: "取消")
  guard alert.runModal() == .alertFirstButtonReturn else { return }
  perform("更新归档状态") { _ = try await self.call("session.archive", ["sessionId": id, "archived": archived]); try await self.refreshAll() }
 }
 func deleteSession(_ id: String) {
  let alert = NSAlert(); alert.messageText = "永久删除此会话？"; alert.informativeText = "将删除此会话历史，无法恢复。工作区已写入的产物不会撤销。"; alert.alertStyle = .warning; alert.addButton(withTitle: "取消"); alert.addButton(withTitle: "永久删除")
  guard alert.runModal() == .alertSecondButtonReturn else { return }
  perform("删除会话") {
   _ = try await self.call("session.delete", ["sessionId": id, "confirm": true])
   let key = ConversationKey(workspace: self.workspace, session: id); self.cachedRuns[key] = nil; self.localFailures[key] = nil; self.drafts[key] = nil
   if self.selectedSession == id { self.newSession() }
   try await self.refreshAll()
  }
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

extension String {
 func nonEmpty(or fallback: String) -> String { isEmpty ? fallback : self }
}

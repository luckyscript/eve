import SwiftUI

struct RemoteAccessInvitation: Identifiable {
 let id: String
 let uri: String
 let expiresAt: Date
}

/// Page state only. All operations share AppModel's existing bridge and host.
@MainActor final class RemoteAccessModel: ObservableObject {
 @Published var snapshot: JSONObject = [:]
 @Published var relayURL = ""
 @Published var desktopName = ""
 @Published var registrationKey = ""
 @Published var allowWrite = false
 @Published var allowCompact = false
 @Published var devLoopback = false
 @Published var contracts: [String: String] = [:]
 @Published var contractName = ""
 @Published var pendingContractPath = ""
 @Published var loading = false
 @Published var loaded = false
 @Published var message: String?
 @Published var invitation: RemoteAccessInvitation?
 private var generation = UUID()
 private var workspace = ""

 var runtime: JSONObject { object(snapshot["runtime"]) }
 var pairs: [JSONObject] { objects(snapshot["pairs"]) }
 var connections: [JSONObject] { objects(runtime["connections"]) }
 var enabled: Bool { runtime["enabled"] as? Bool == true }
 var configured: Bool { object(snapshot["settings"])["registrationConfigured"] as? Bool == true }
 var remoteBusy: Bool { runtime["busy"] as? Bool == true }
 var hasChanges: Bool {
  let saved = object(snapshot["settings"])
  return !registrationKey.isEmpty || relayURL.trimmingCharacters(in: .whitespacesAndNewlines) != text(saved["relayUrl"])
   || desktopName.trimmingCharacters(in: .whitespacesAndNewlines) != text(saved["desktopName"])
   || allowWrite != (saved["allowWrite"] as? Bool ?? false) || allowCompact != (saved["allowCompact"] as? Bool ?? false)
   || devLoopback != (saved["development"] as? Bool ?? false) || contracts != (saved["contracts"] as? [String: String] ?? [:])
 }
 var values: JSONObject {
  var result: JSONObject = ["relayUrl": relayURL.trimmingCharacters(in: .whitespacesAndNewlines), "desktopName": desktopName.trimmingCharacters(in: .whitespacesAndNewlines), "allowWrite": allowWrite, "allowCompact": allowCompact, "development": devLoopback, "contracts": contracts]
  // Empty means keep the stored credential. Never fill this from status.
  if !registrationKey.isEmpty { result["registrationKey"] = registrationKey }
  return result
 }
 func leave() {
  generation = UUID(); invitation = nil; registrationKey = ""; loading = false
 }
 func load(_ model: AppModel) async {
  leave(); workspace = model.workspace; loaded = false; snapshot = [:]
  relayURL = ""; desktopName = ""; allowWrite = false; allowCompact = false
  devLoopback = false; contracts = [:]; contractName = ""; pendingContractPath = ""; message = nil
  guard !workspace.isEmpty, model.connected else { return }
  await execute("remote.status", model: model, updateDraft: true)
 }
 func run(_ op: String, model: AppModel, params: JSONObject = [:], updateDraft: Bool = false) {
  guard !loading, model.connected, !model.workspace.isEmpty else { return }
  Task { await execute(op, model: model, params: params, updateDraft: updateDraft) }
 }
 private func execute(_ op: String, model: AppModel, params: JSONObject = [:], updateDraft: Bool = false) async {
  guard !loading, workspace == model.workspace else { return }
  let token = generation, root = workspace
  let shouldUpdateDraft = updateDraft || (op == "remote.status" && !loaded)
  loading = true; message = nil
  defer { if generation == token { loading = false } }
  do {
   let result = object(try await model.call(op, params))
   guard generation == token, root == model.workspace, !Task.isCancelled else { return }
   if op == "remote.invite" {
    guard let uri = result["uri"] as? String, uri.hasPrefix("eve://pair?data="),
          let expires = result["expiresAt"] as? NSNumber, let pairID = result["pairId"] as? String else {
     message = "邀请响应无效，请刷新后重试。"; return
    }
    invitation = RemoteAccessInvitation(id: pairID, uri: uri, expiresAt: Date(timeIntervalSince1970: expires.doubleValue / 1000))
   } else {
    snapshot = result; loaded = true
    if shouldUpdateDraft {
     let settings = object(result["settings"])
     relayURL = text(settings["relayUrl"]); desktopName = text(settings["desktopName"])
     allowWrite = settings["allowWrite"] as? Bool ?? false
     allowCompact = settings["allowCompact"] as? Bool ?? false
     devLoopback = settings["development"] as? Bool ?? false
     contracts = settings["contracts"] as? [String: String] ?? [:]
     registrationKey = ""
    }
    if op == "remote.configure" { message = "远程设置已保存。" }
    else if op == "remote.revoke" { message = "设备授权已撤销。" }
   }
  } catch {
   guard generation == token, root == model.workspace else { return }
   // Only classified host errors have deliberately safe, actionable messages.
   if let failure = error as? BridgeFailure, failure.code.hasPrefix("REMOTE_") || ["WORKSPACE_NOT_READY", "LOCK", "CONNECTION", "CONFIG"].contains(failure.code) {
    message = failure.localizedDescription
   } else {
    message = "远程操作未完成。请检查中继地址、工作区是否忙碌，或是否已有其他 Eve 进程提供远程服务。"
   }
  }
 }
 func addContract() {
  let name = contractName.trimmingCharacters(in: .whitespacesAndNewlines)
  guard name.range(of: "^[A-Za-z0-9_-]{1,64}$", options: .regularExpression) != nil, !pendingContractPath.isEmpty else {
   message = "契约名需为 1–64 位字母、数字、下划线或连字符，并选择一个本地文件。"; return
  }
  contracts[name] = pendingContractPath; contractName = ""; pendingContractPath = ""; message = nil
 }
}

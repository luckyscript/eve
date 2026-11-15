import SwiftUI
import AppKit
import CoreImage.CIFilterBuiltins

@MainActor struct RemoteAccessView: View {
 @ObservedObject var model: AppModel
 @StateObject private var remote = RemoteAccessModel()
 private var blocked: Bool { remote.loading || model.busy || !model.connected || !remote.loaded }
 var body: some View {
  ScrollView {
   VStack(alignment: .leading, spacing: 18) {
    HStack(alignment: .top) {
     VStack(alignment: .leading, spacing: 6) {
      Label("让自己的设备连接 Eve", systemImage: "network").font(.title3.weight(.semibold))
      Text("当前工作区通过中继建立出站加密连接。权限由本机明确授予，默认关闭写入与压缩。").font(.callout).foregroundStyle(.secondary)
     }
     Spacer()
     Button { remote.run("remote.status", model: model) } label: { Label("刷新状态", systemImage: "arrow.clockwise") }
      .disabled(remote.loading || !model.connected || model.workspace.isEmpty)
    }
    if let message = remote.message { Label(message, systemImage: "exclamationmark.circle").font(.callout).foregroundStyle(.orange).textSelection(.enabled) }
    statusCard
    settingsCard
    contractsCard
    devicesCard
   }.padding(24).frame(maxWidth: EveTheme.contentWidth).frame(maxWidth: .infinity, alignment: .top)
  }
  .task(id: model.workspace) { await remote.load(model) }
  .onDisappear { remote.leave() }
  .sheet(item: $remote.invitation, onDismiss: { remote.run("remote.status", model: model) }) { invite in RemoteInvitationSheet(invitation: invite) }
 }
 private var statusCard: some View {
  GroupBox {
   VStack(alignment: .leading, spacing: 12) {
    HStack(spacing: 10) {
     Circle().fill(remote.enabled ? Color.green : Color.secondary).frame(width: 8, height: 8)
     Text(!remote.loaded ? "尚未读取状态" : remote.enabled ? "远程访问已启用" : "远程访问已停止").font(.headline)
     Spacer()
     if remote.loading { ProgressView().controlSize(.small) }
     if remote.remoteBusy { Text("远程任务运行中").font(.caption).foregroundStyle(.secondary) }
    }
    Text("\(remote.connections.filter { text($0["state"]) == "online" }.count) 个中继连接在线 · \(remote.connections.reduce(0) { $0 + ($1["authenticated"] as? Int ?? 0) }) 个已认证连接").font(.caption).foregroundStyle(.secondary)
    HStack {
     Button(remote.enabled ? "停止远程访问" : "启用远程访问") { remote.run(remote.enabled ? "remote.stop" : "remote.start", model: model) }
      .buttonStyle(.borderedProminent).disabled(blocked || (!remote.enabled && (remote.remoteBusy || remote.hasChanges || remote.relayURL.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)))
     Button("生成邀请…") { remote.run("remote.invite", model: model) }
      .disabled(blocked || remote.remoteBusy || !remote.enabled)
     Spacer()
    }
    if remote.loaded && remote.relayURL.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { Text("先填写并保存中继地址，再启用远程访问和生成邀请。").font(.caption).foregroundStyle(.secondary) }
    else if remote.loaded && remote.hasChanges { Text("设置有未保存的更改，请先保存再启用远程访问。").font(.caption).foregroundStyle(.orange) }
    Text("启用使用已保存设置，不会自动授予额外权限。停止会等待远程任务收尾；工作区切换与应用退出由宿主统一关闭连接。").font(.caption).foregroundStyle(.secondary)
   }.padding(10).frame(maxWidth: .infinity, alignment: .leading)
  }
 }
 private var settingsCard: some View {
  GroupBox("中继与权限") {
   VStack(alignment: .leading, spacing: 12) {
    LabeledContent("中继地址") { TextField("https://relay.example.com", text: $remote.relayURL).textFieldStyle(.roundedBorder).accessibilityLabel("中继地址") }
    LabeledContent("本机名") { TextField("设备名称", text: $remote.desktopName).textFieldStyle(.roundedBorder) }
    LabeledContent("中继注册密钥") { SecureField(remote.configured ? "已配置 · 输入新值以替换" : "可选中继注册凭据", text: $remote.registrationKey).textFieldStyle(.roundedBorder).accessibilityLabel("中继注册密钥") }
    Text("已存凭据不会回显；留空保留原值。凭据只用于本机向中继注册。").font(.caption).foregroundStyle(.secondary)
    Divider()
    Toggle("允许远程写入 / 编辑工作区文件", isOn: $remote.allowWrite)
    Toggle("允许远程压缩会话上下文", isOn: $remote.allowCompact)
    Toggle("允许本机明文测试（高级）", isOn: $remote.devLoopback)
    Text("生产中继必须使用 HTTPS / WSS。本机测试只允许 localhost、127.0.0.1 或 ::1 的明文地址，不开放公网监听端口。").font(.caption).foregroundStyle(.secondary)
    HStack {
     Button("保存设置") { remote.run("remote.configure", model: model, params: ["values": remote.values], updateDraft: true) }.disabled(remote.remoteBusy)
     Text("权限与契约修改在保存后生效。").font(.caption).foregroundStyle(.secondary)
    }
   }.padding(10).frame(maxWidth: .infinity, alignment: .leading)
  }.disabled(blocked)
 }
 private var contractsCard: some View {
  GroupBox("可用验收契约") {
   VStack(alignment: .leading, spacing: 10) {
    Text("远程设备只能按这里的名称使用契约；文件路径由本机选择。").font(.caption).foregroundStyle(.secondary)
    if remote.contracts.isEmpty { Text("尚未授权任何命名契约").foregroundStyle(.secondary) }
    ForEach(remote.contracts.keys.sorted(), id: \.self) { name in
     HStack {
      VStack(alignment: .leading, spacing: 3) {
       Text(name).font(.callout.weight(.medium))
       Text(remote.contracts[name] ?? "").font(.caption).foregroundStyle(.secondary).textSelection(.enabled).lineLimit(2)
      }
      Spacer()
      Button("移除", role: .destructive) { remote.contracts.removeValue(forKey: name) }
     }
    }
    HStack {
     TextField("契约名（如 review）", text: $remote.contractName).textFieldStyle(.roundedBorder)
     Button("选择本地文件…") {
      let panel = NSOpenPanel()
      panel.canChooseFiles = true; panel.canChooseDirectories = false; panel.allowsMultipleSelection = false
      panel.prompt = "添加契约"
      if panel.runModal() == .OK { remote.pendingContractPath = panel.url?.path ?? "" }
     }
     Button("添加") { remote.addContract() }.disabled(remote.pendingContractPath.isEmpty)
    }
    if !remote.pendingContractPath.isEmpty { Text(remote.pendingContractPath).font(.caption).foregroundStyle(.secondary).textSelection(.enabled) }
   }.padding(10).frame(maxWidth: .infinity, alignment: .leading)
  }.disabled(blocked || remote.remoteBusy)
 }
 private var devicesCard: some View {
  GroupBox("连接与已配对设备") {
   VStack(alignment: .leading, spacing: 12) {
    if remote.pairs.isEmpty { Text("尚无配对设备。启用后，生成一个仅供自己设备使用的邀请。").foregroundStyle(.secondary) }
    ForEach(Array(remote.pairs.enumerated()), id: \.offset) { _, pair in
     let id = text(pair["pairId"])
     let revoked = pair["revoked"] as? Bool == true
     let bound = pair["bound"] as? Bool == true
     let connection = remote.connections.first { text($0["pairId"]) == id }
     HStack(spacing: 12) {
      Image(systemName: bound ? "iphone" : "qrcode").foregroundStyle(.secondary)
      VStack(alignment: .leading, spacing: 4) {
       Text(text(pair["clientName"]).isEmpty ? (bound ? "已配对设备" : "待配对邀请") : text(pair["clientName"])).font(.callout.weight(.medium))
       Text(id).font(.system(.caption2, design: .monospaced)).foregroundStyle(.tertiary).textSelection(.enabled)
       if !bound, let expiry = pair["expiresAt"] as? NSNumber {
        Text("邀请到期：\(Date(timeIntervalSince1970: expiry.doubleValue / 1000).formatted(date: .omitted, time: .standard))").font(.caption).foregroundStyle(.secondary)
       }
      }
      Spacer()
      Text(revoked ? "已撤销" : text(connection?["state"]).isEmpty ? (bound ? "离线" : "待配对") : displayStatus(text(connection?["state"]))).font(.caption).foregroundStyle(.secondary)
      Button("撤销", role: .destructive) { remote.run("remote.revoke", model: model, params: ["pairId": id]) }.disabled(blocked || revoked)
     }
     if id != text(remote.pairs.last?["pairId"]) { Divider() }
    }
   }.padding(10).frame(maxWidth: .infinity, alignment: .leading)
  }
 }
}

@MainActor private struct RemoteInvitationSheet: View {
 let invitation: RemoteAccessInvitation
 @Environment(\.dismiss) private var dismiss
 @State private var copied = false
 private var qrImage: NSImage? {
  let filter = CIFilter.qrCodeGenerator()
  filter.message = Data(invitation.uri.utf8); filter.correctionLevel = "M"
  guard let output = filter.outputImage,
        let image = CIContext().createCGImage(output.transformed(by: CGAffineTransform(scaleX: 6, y: 6)), from: output.extent.applying(CGAffineTransform(scaleX: 6, y: 6))) else { return nil }
  return NSImage(cgImage: image, size: NSSize(width: image.width, height: image.height))
 }
 var body: some View {
  TimelineView(.periodic(from: .now, by: 1)) { context in
   let expired = context.date >= invitation.expiresAt
   VStack(spacing: 16) {
    Text("配对你的设备").font(.title2.weight(.semibold))
    Text("配对二维码和链接可授权设备访问当前工作区，仅供自己的设备使用。\n请勿转发、截图或粘贴到日志。").font(.callout).foregroundStyle(.secondary).multilineTextAlignment(.center)
    if expired {
     ContentUnavailableView("邀请已过期", systemImage: "clock.badge.exclamationmark", description: Text("关闭后重新生成邀请。"))
      .frame(width: 300, height: 300)
    } else if let image = qrImage {
     Image(nsImage: image).interpolation(.none).resizable().scaledToFit().padding(16).frame(width: 300, height: 300).background(.white, in: RoundedRectangle(cornerRadius: 12)).accessibilityLabel("私密配对二维码")
    } else {
     Text("无法生成二维码，请复制链接完成配对。").frame(width: 300, height: 300)
    }
    if !expired { HStack { Text("10 分钟有效 · 剩余"); Text(invitation.expiresAt, style: .timer).monospacedDigit() }.font(.caption).foregroundStyle(.secondary) }
    HStack {
     Button(copied ? "已复制链接" : "复制邀请链接") {
      guard Date() < invitation.expiresAt else { return }
      let board = NSPasteboard.general
      board.clearContents(); board.setString(invitation.uri, forType: .string)
      board.setData(Data(), forType: NSPasteboard.PasteboardType("org.nspasteboard.ConcealedType"))
      copied = true
     }.disabled(expired)
     Button("完成") { dismiss() }.keyboardShortcut(.defaultAction)
    }
    Text("关闭或到期后，清除本次复制的链接。").font(.caption2).foregroundStyle(.secondary)
   }.padding(28).frame(width: 420)
  }
  .task {
   let remaining = max(0, invitation.expiresAt.timeIntervalSinceNow)
   do { try await Task.sleep(for: .seconds(remaining)); clearClipboard() } catch { }
  }
  .onDisappear { clearClipboard() }
 }
 private func clearClipboard() {
  let board = NSPasteboard.general
  if board.string(forType: .string) == invitation.uri { board.clearContents() }
 }
}

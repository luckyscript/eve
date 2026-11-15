import SwiftUI
import EveProtocol

struct ContentView: View {
 @ObservedObject var model: AppModel
 @AppStorage("appearance") private var appearance = "system"
 @State private var search = ""
 @State private var visibleSessions = 40
 @State private var showSearch = false
 @State private var showWorkbench = true
 @State private var columns: NavigationSplitViewVisibility = .all
 @FocusState private var searchFocused: Bool
 var filteredSessions: [JSONObject] {
  Array(model.sessions.reversed().prefix(visibleSessions))
 }
 var body: some View {
  NavigationSplitView(columnVisibility: $columns) {
   sidebar.navigationSplitViewColumnWidth(min: 240, ideal: 260, max: 320)
    .toolbar(removing: .sidebarToggle)
  } detail: {
   VStack(spacing: 0) {
    header
    Rectangle().fill(EveTheme.separator).frame(height: 1)
    if model.workspace.isEmpty && model.page != .settings {
     ContentUnavailableView { Label("选择一个工作区", systemImage: "folder.badge.plus") } description: { Text("在你的工作区里，与 Eve 一起完成任务。") } actions: { Button("选择工作区…", action: model.chooseWorkspace).buttonStyle(.borderedProminent).disabled(!model.connected || model.busy) }.frame(maxWidth: .infinity, maxHeight: .infinity)
    } else {
     switch model.page {
     case .chat: ChatView(model: model)
     case .tools: ToolsView(model: model)
     case .skills: SkillsView(model: model)
     case .capabilities: CapabilitiesView(model: model)
     case .evolution: EvolutionView(model: model)
     case .remote: RemoteAccessView(model: model)
     case .settings: SettingsView(model: model)
     }
    }
   }.frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top).background(EveTheme.canvas)
    .toolbar(removing: .sidebarToggle)
  }
  .font(.system(size: 13)).tint(EveTheme.accent).groupBoxStyle(EveGroupBoxStyle())
  .preferredColorScheme(appearance == "light" ? .light : appearance == "dark" ? .dark : nil)
  .onReceive(NotificationCenter.default.publisher(for: .eveSearch)) { _ in showSearch = true; searchFocused = true }
  .onChange(of: search) { _, value in model.sessionQuery = value; visibleSessions = 40 }
  .task(id: search) {
   do { try await Task.sleep(for: .milliseconds(350)); try Task.checkCancellation(); model.searchSessions() } catch {}
  }
  .onExitCommand { showSearch = false; search = "" }
  .alert("Eve 操作提示", isPresented: Binding(get: { model.error != nil }, set: { if !$0 { model.error = nil } })) {
   Button("好") { model.error = nil }
   if !model.connected { Button("重新连接并核验", action: model.reconnect) }
   if model.errorCode == "LOCK", !model.selectedSession.isEmpty { Button("读取会话状态", action: model.status) }
   if model.errorCode == "LIMIT", model.historyHasMore { Button("加载较早历史", action: model.loadOlderHistory) }
   Button("打开设置") { model.error = nil; model.page = .settings }
  } message: { Text((model.errorCode.isEmpty ? "" : "[\(model.errorCode)] ") + (model.error ?? "")) }
 }
 private var sidebar: some View {
  VStack(alignment: .leading, spacing: 0) {
   HStack(spacing: 6) {
    EveBrandMark(size: 30)
    Text("Eve").font(.system(size: 17, weight: .semibold))
    Spacer()
    QuietIconButton(title: "搜索会话", symbol: "magnifyingglass") { showSearch.toggle(); searchFocused = showSearch; if !showSearch { search = "" } }
    QuietIconButton(title: "新会话", symbol: "square.and.pencil", action: model.newSession)
   }.padding(.horizontal, 16).padding(.top, 14).padding(.bottom, 14)
   Button(action: model.chooseWorkspace) {
    HStack(spacing: 9) {
     Image(systemName: "folder").foregroundStyle(.secondary)
     Text(model.workspace.isEmpty ? "选择工作区…" : URL(fileURLWithPath: model.workspace).lastPathComponent).lineLimit(1)
     Spacer(minLength: 0)
     Image(systemName: "chevron.up.chevron.down").font(.system(size: 9)).foregroundStyle(.tertiary)
    }.padding(.horizontal, 11).padding(.vertical, 10).background(EveTheme.surface, in: RoundedRectangle(cornerRadius: 10))
     .overlay(RoundedRectangle(cornerRadius: 10).stroke(EveTheme.separator))
   }.buttonStyle(.plain).disabled(!model.connected || (model.busy && model.runningOrigin == nil)).help(model.workspace).padding(.horizontal, 12)
   if showSearch {
    HStack(spacing: 6) {
     Image(systemName: "magnifyingglass").foregroundStyle(.secondary)
     TextField("搜索会话", text: $search).textFieldStyle(.plain).focused($searchFocused).accessibilityLabel("搜索会话")
     Button("搜索", action: model.searchSessions).disabled(model.busy)
     if !search.isEmpty { QuietIconButton(title: "清除搜索", symbol: "xmark.circle.fill") { search = "" } }
    }.padding(9).background(EveTheme.surface, in: RoundedRectangle(cornerRadius: 9)).padding(.horizontal, 12).padding(.top, 10)
   }
   Toggle("显示已归档", isOn: $model.includeArchived).font(.caption).padding(.horizontal, 16).padding(.top, 8)
    .onChange(of: model.includeArchived) { _, _ in model.searchSessions() }
   if model.settingsDirty && model.page != .settings { Button("设置草稿已保留 · 返回保存") { model.page = .settings }.font(.caption).padding(12) }
   if !model.connected { Button("重新连接并核验会话", action: model.reconnect).padding(12) }
   ScrollView {
    LazyVStack(alignment: .leading, spacing: 3) {
     if !model.draftConversations.isEmpty {
      Text("草稿").font(.caption).foregroundStyle(.secondary).padding(10)
      ForEach(model.draftConversations, id: \.self) { key in
       Button { model.resumeDraft(key) } label: { Label(model.draftTitle(key), systemImage: "pencil").lineLimit(1).frame(maxWidth: .infinity, alignment: .leading).padding(9) }.buttonStyle(.plain)
      }
     }
     DisclosureGroup(isExpanded: $showWorkbench) {
      ForEach(Page.allCases.filter { $0 != .settings && $0 != .chat }) { page in
       sidebarPage(page)
      }
     } label: { Text("工作台").font(.system(size: 11, weight: .medium)).foregroundStyle(.secondary) }
      .padding(.horizontal, 9).padding(.top, 18).padding(.bottom, 14)
     HStack { Text("会话"); Spacer(); Text("\(model.sessions.count)").monospacedDigit() }.font(.system(size: 11, weight: .medium)).foregroundStyle(.secondary).padding(.horizontal, 11).padding(.bottom, 7)
     if filteredSessions.isEmpty {
      Text(search.isEmpty ? "从一个新想法开始" : "没有匹配的会话").font(.caption).foregroundStyle(.tertiary).padding(11)
     }
     ForEach(Array(filteredSessions.enumerated()), id: \.offset) { _, session in
      let id = text(session["id"])
      Button { model.resume(id) } label: {
       VStack(alignment: .leading, spacing: 4) {
        Text(model.sessionTitle(id)).lineLimit(1).font(.system(size: 13))
        Text("\(text(session["runs"])) 轮 · \(displayStatus(text(session["status"])))").font(.system(size: 10)).foregroundStyle(.secondary).lineLimit(1)
       }.frame(maxWidth: .infinity, alignment: .leading).padding(.horizontal, 11).padding(.vertical, 9)
        .background(model.selectedSession == id && model.page == .chat ? EveTheme.selection : .clear, in: RoundedRectangle(cornerRadius: 9))
      }.buttonStyle(.plain).help("\(model.sessionTitle(id))\n\(id)")
      .contextMenu {
       Button("重命名…") { model.renameSession(id) }
       Button(session["archived"] as? Bool == true ? "恢复归档…" : "归档…") { model.archiveSession(id, archived: session["archived"] as? Bool != true) }
       Button("删除…", role: .destructive) { model.deleteSession(id) }
      }.disabled(model.busy && !model.isRunning)
     }
     if visibleSessions < model.sessions.count { Button("显示更多会话") { visibleSessions += 40 }.padding(10) }
    }.padding(.horizontal, 10)
   }
   HStack(spacing: 7) {
    Circle().fill(model.connected ? EveTheme.accent : .orange).frame(width: 6, height: 6)
    Text(model.busy ? model.activity : model.connected ? "本地管道 · 就绪" : "Bridge 已断开").font(.system(size: 10)).foregroundStyle(.secondary).lineLimit(1)
    Spacer(minLength: 0)
    QuietIconButton(title: "设置", symbol: "gearshape") { model.page = .settings }
   }.padding(.horizontal, 16).padding(.vertical, 12)
  }.background(EveTheme.sidebar).clipShape(RoundedRectangle(cornerRadius: 14)).padding(.leading, 7).padding(.vertical, 6)
 }
 private func sidebarPage(_ page: Page) -> some View {
  Button { model.page = page } label: {
   Label(page.rawValue, systemImage: page.symbol).font(.system(size: 12)).frame(maxWidth: .infinity, alignment: .leading).padding(.horizontal, 10).padding(.vertical, 7)
    .background(model.page == page ? EveTheme.selection : .clear, in: RoundedRectangle(cornerRadius: 8))
  }.buttonStyle(.plain)
 }
 private var header: some View {
  HStack(spacing: 12) {
   QuietIconButton(title: "切换侧栏", symbol: "sidebar.left") { columns = columns == .detailOnly ? .all : .detailOnly }
   VStack(alignment: .leading, spacing: 3) {
    Text(model.page == .chat ? model.chatTitle : model.page.rawValue).font(.system(size: 13, weight: .semibold)).lineLimit(1)
    if !model.workspace.isEmpty { Text(URL(fileURLWithPath: model.workspace).lastPathComponent).font(.system(size: 10)).foregroundStyle(.tertiary).help(model.workspace) }
   }
   Spacer()
   if model.busy {
    ProgressView().controlSize(.mini)
    Text(model.activity).font(.caption).foregroundStyle(.secondary).lineLimit(1)
    if model.isRunning {
     if model.runningOrigin != nil && !model.showingRunning { Button("返回运行", action: model.returnToRunning) }
     Button(model.cancelRequested ? "等待收尾…" : "取消运行", action: model.cancel).controlSize(.small).disabled(model.cancelRequested).help(model.cancelState).accessibilityLabel("取消运行")
    }
   } else {
    QuietIconButton(title: "刷新当前工作区", symbol: "arrow.clockwise", action: model.refresh).disabled(model.workspace.isEmpty || !model.connected)
   }
  }.padding(.horizontal, 18).frame(height: 56)
 }
}

func displayStatus(_ value: String) -> String {
 let labels = ["completed": "已完成", "passed": "通过", "failed": "失败", "running": "运行中", "pending": "等待中", "not_requested": "未请求", "not_checked": "未检查", "cancelled": "已取消", "interrupted": "已中断", "unknown": "结果未知", "rejected": "未通过", "promoted": "已发布", "active": "使用中", "evaluated": "已评测", "unreadable": "无法读取", "unavailable": "暂不可用", "new": "新会话", "online": "在线", "offline": "离线", "connecting": "连接中", "disconnected": "已断开", "retrying": "重连中", "expired": "已到期"]
 return labels[value] ?? (value.isEmpty ? "—" : value)
}

struct StatusBadge: View {
 let label: String
 let value: String
 var color: Color { ["completed", "passed", "promoted", "active", "evaluated"].contains(value) ? EveTheme.accent : ["failed", "cancelled", "rejected", "interrupted", "unknown", "unreadable"].contains(value) ? .orange : .secondary }
 var body: some View { HStack(spacing: 4) { Text(label).foregroundStyle(.secondary); Text(displayStatus(value)).foregroundStyle(color) }.font(.system(size: 10)).padding(.horizontal, 7).padding(.vertical, 4).background(color.opacity(0.06), in: Capsule()) }
}
struct JSONDetails: View {
 let title: String
 let value: Any?
 var body: some View { DisclosureGroup(title) { Text(pretty(value)).font(.system(.caption, design: .monospaced)).textSelection(.enabled).frame(maxWidth: .infinity, alignment: .leading).padding(8) }.font(.caption).foregroundStyle(.secondary).padding(.vertical, 4).accessibilityLabel(title) }
}

extension Notification.Name { static let eveSearch = Notification.Name("eve.search") }

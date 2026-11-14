import SwiftUI

struct ContentView: View {
 @ObservedObject var model: AppModel
 var body: some View {
  NavigationSplitView {
   VStack(alignment: .leading, spacing: 0) {
    VStack(alignment: .leading, spacing: 8) {
     Label("EVE", systemImage: "sparkle").font(.title2.bold())
     Button(action: model.chooseWorkspace) { Label(model.workspace.isEmpty ? "选择工作区…" : URL(fileURLWithPath: model.workspace).lastPathComponent, systemImage: "folder") }.disabled(model.busy || !model.connected)
     Text(model.workspace.isEmpty ? "开始前选择允许 eve 读写的目录" : model.workspace).font(.caption).foregroundStyle(.secondary).lineLimit(2).textSelection(.enabled)
    }.padding()
    List {
     Section("工作台") {
      ForEach(Page.allCases) { page in Button { model.page = page } label: { Label(page.rawValue, systemImage: page.symbol).foregroundStyle(model.page == page ? Color.accentColor : Color.primary).frame(maxWidth: .infinity, alignment: .leading) }.buttonStyle(.plain).padding(.vertical, 4) }
     }
     Section {
      Button(action: model.newSession) { Label("新会话", systemImage: "plus") }.disabled(model.busy)
      ForEach(Array(model.sessions.reversed().enumerated()), id: \.offset) { _, session in
       Button { model.resume(text(session["id"])) } label: {
        VStack(alignment: .leading, spacing: 4) {
         Text(text(session["id"])).lineLimit(1).truncationMode(.middle).font(.system(.caption, design: .monospaced))
         Text("\(text(session["runs"])) 轮 · \(text(session["status"]))").font(.caption2).foregroundStyle(.secondary)
        }.padding(.vertical, 3)
       }.buttonStyle(.plain).disabled(model.busy).listRowBackground(text(session["id"]) == model.selectedSession ? Color.accentColor.opacity(0.12) : Color.clear)
      }
     } header: { Text("会话 · \(model.sessions.count)") }
    }.listStyle(.sidebar)
    HStack(spacing: 8) { Circle().fill(model.connected ? Color.green : Color.red).frame(width: 7, height: 7); Text(model.busy ? model.activity : model.connected ? "本地管道 · 就绪" : "Bridge 已断开").font(.caption).lineLimit(2) }.padding()
   }.navigationSplitViewColumnWidth(min: 210, ideal: 245, max: 320)
  } detail: {
   VStack(spacing: 0) {
    HStack {
     VStack(alignment: .leading) { Text(model.page.rawValue).font(.title2.bold()); Text(model.workspace.isEmpty ? "原生 SwiftUI · 现有 eve 核心" : model.workspace).font(.caption).foregroundStyle(.secondary).lineLimit(1) }
     Spacer()
     if model.busy { ProgressView().controlSize(.small); Text(model.activity).font(.caption).lineLimit(1); Button(model.cancelRequested ? "正在收尾…" : "取消运行", action: model.cancel).disabled(model.cancelRequested) }
     else { Button(action: model.refresh) { Image(systemName: "arrow.clockwise") }.help("刷新当前工作区").disabled(model.workspace.isEmpty || !model.connected) }
    }.padding().background(.bar)
    Divider()
    if model.workspace.isEmpty {
     ContentUnavailableView { Label("选择一个工作区", systemImage: "folder.badge.plus") } description: { Text("Eve 使用该目录的配置、技能和私有会话账本。") } actions: { Button("选择工作区…", action: model.chooseWorkspace).buttonStyle(.borderedProminent).disabled(!model.connected) }
    } else {
     switch model.page {
     case .chat: ChatView(model: model)
     case .tools: ToolsView(model: model)
     case .skills: SkillsView(model: model)
     case .capabilities: CapabilitiesView(model: model)
     case .evolution: EvolutionView(model: model)
     case .settings: SettingsView(model: model)
     }
    }
   }
  }
  .alert("Eve 操作提示", isPresented: Binding(get: { model.error != nil }, set: { if !$0 { model.error = nil } })) { Button("好") { model.error = nil } } message: { Text(model.error ?? "") }
 }
}

struct StatusBadge: View {
 let label: String
 let value: String
 var color: Color { ["completed", "passed", "promoted", "active", "evaluated"].contains(value) ? .green : ["failed", "cancelled", "rejected", "interrupted", "unknown", "unreadable"].contains(value) ? .orange : .secondary }
 var body: some View { HStack(spacing: 5) { Text(label).foregroundStyle(.secondary); Text(value.isEmpty ? "—" : value).foregroundStyle(color).bold() }.font(.caption).padding(.horizontal, 9).padding(.vertical, 5).background(color.opacity(0.08), in: RoundedRectangle(cornerRadius: 7)) }
}
struct JSONDetails: View {
 let title: String
 let value: Any?
 var body: some View { DisclosureGroup(title) { Text(pretty(value)).font(.system(.caption, design: .monospaced)).textSelection(.enabled).frame(maxWidth: .infinity, alignment: .leading).padding(8) }.padding(.vertical, 5) }
}

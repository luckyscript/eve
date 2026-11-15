import SwiftUI
import AppKit

struct ToolsView: View {
 @ObservedObject var model: AppModel
 var body: some View {
  ScrollView { LazyVStack(alignment: .leading, spacing: 14) {
   Text("工具由现有核心执行，文件路径限制在工作区内。").foregroundStyle(.secondary)
   ForEach(Array(model.tools.enumerated()), id: \.offset) { _, item in
    let function = object(item["function"])
    GroupBox { VStack(alignment: .leading, spacing: 8) { Label(text(function["name"]), systemImage: "wrench").font(.headline); Text(text(function["description"])).textSelection(.enabled); JSONDetails(title: "参数 schema", value: function["parameters"]) }.frame(maxWidth: .infinity, alignment: .leading).padding(8) }
   }
  }.padding(24).frame(maxWidth: EveTheme.contentWidth).frame(maxWidth: .infinity, alignment: .top) }
 }
}
struct SkillsView: View {
 @ObservedObject var model: AppModel
 var body: some View {
  VStack(alignment: .leading, spacing: 12) {
   HStack { Text("按需加载 · 哈希校验 · 下一任务使用当前发布版本").foregroundStyle(.secondary); Spacer(); Button("导入可信基线…", action: model.importSkill).disabled(model.busy) }
   ForEach(model.warnings, id: \.self) { Text($0).font(.caption).foregroundStyle(.orange) }
   Table(Array(model.skills.enumerated()).map { SkillRow(id: $0.offset, value: $0.element) }) {
    TableColumn("名称") { row in Text(text(row.value["name"])) }.width(min: 120, ideal: 180)
    TableColumn("说明") { row in Text(text(row.value["description"])).textSelection(.enabled) }
    TableColumn("SHA-256") { row in Text(text(row.value["hash"])).font(.system(.caption, design: .monospaced)).textSelection(.enabled) }.width(min: 160, ideal: 210)
   }
  }.padding(24)
 }
}
struct SkillRow: Identifiable { let id: Int; let value: JSONObject }
struct CapabilitiesView: View {
 @ObservedObject var model: AppModel
 var body: some View {
  ScrollView { VStack(alignment: .leading, spacing: 16) {
   HStack { Text("能力注册表 · revision \(text(model.capabilities["revision"]))").font(.headline); Spacer(); Button("导入可信基线…", action: model.importSkill).disabled(model.busy) }
   GroupBox("当前发布技能") { VStack(alignment: .leading, spacing: 12) {
    let active = object(model.capabilities["active"])
    if active.isEmpty { Text("暂无发布技能。可导入可信 SKILL.md 作为基线。").foregroundStyle(.secondary) }
    ForEach(active.keys.sorted(), id: \.self) { name in HStack { VStack(alignment: .leading) { Text(name).bold(); Text(text(active[name])).font(.system(.caption, design: .monospaced)).textSelection(.enabled) }; Spacer(); Button("回滚", role: .destructive) { model.rollback(name) }.disabled(model.busy).help("恢复 parent；不会撤销工作区文件副作用") } }
   }.frame(maxWidth: .infinity, alignment: .leading).padding(8) }
   Text("候选与基线").font(.headline)
   ForEach(Array(objects(model.capabilities["candidates"]).enumerated()), id: \.offset) { _, c in
    GroupBox { VStack(alignment: .leading, spacing: 8) {
     HStack { Text(text(c["name"])).bold(); StatusBadge(label: "状态", value: text(c["status"])); Spacer(); if text(c["status"]) == "evaluated" { Button("发布候选") { model.promote(text(c["id"])) }.disabled(model.busy) } }
     Text(text(c["id"])).font(.system(.caption, design: .monospaced)).textSelection(.enabled)
     JSONDetails(title: "版本证据", value: c)
    }.frame(maxWidth: .infinity, alignment: .leading).padding(8) }
   }
  }.padding(24).frame(maxWidth: EveTheme.contentWidth).frame(maxWidth: .infinity, alignment: .top) }
 }
}
struct SettingsView: View {
 @ObservedObject var model: AppModel
 @AppStorage("appearance") private var appearance = "system"
 @AppStorage("enterInsertsNewline") private var enterNewline = false
 let numericLabels = ["maxSteps": "最大推理步数（1–100 步）", "maxToolCalls": "最大工具调用（1–200 次）", "timeoutMs": "单请求超时（1–600000 毫秒）", "maxOutputTokens": "最大输出（1–32768 tokens）", "maxToolChars": "工具输出上限（1–131072 字符）", "temperature": "采样温度（0–2）", "contextMaxChars": "上下文上限（4096–200000 字符）", "contextRecentGroups": "保留近期组数（1–20 组）", "contextSummaryChars": "摘要上限（1–16000 字符）"]
 let numericKeys = ["maxSteps", "maxToolCalls", "timeoutMs", "maxOutputTokens", "maxToolChars", "temperature", "contextMaxChars", "contextRecentGroups", "contextSummaryChars"]
 var body: some View {
  Form {
   if model.workspace.isEmpty {
    Section("选择工作区以设置连接") {
     Text("外观与键盘偏好保存在本机。模型连接、密钥和预算属于各自工作区。")
     Button("选择工作区…", action: model.chooseWorkspace)
    }
   }
   if model.settingsDirty { Section { Label("设置草稿尚未保存；刷新及离开此页都会保留编辑。切换工作区前会提示。", systemImage: "pencil.circle").foregroundStyle(.orange) } }
   if !model.settingsFeedback.isEmpty { Section { Label(model.settingsFeedback, systemImage: "checkmark.circle").foregroundStyle(EveTheme.accent) } }
   if !model.configDiagnostics.isEmpty {
    Section("配置诊断") {
     ForEach(Array(model.configDiagnostics.enumerated()), id: \.offset) { _, diagnostic in
      Text("[\(text(diagnostic["code"]))] \(text(diagnostic["message"]))\n\(text(diagnostic["path"]))").textSelection(.enabled)
     }
     Button("备份并修复本地配置…", action: model.repairSettings).disabled(model.busy)
    }
   }
   Section("关于 Eve") {
    HStack(spacing: 12) {
     EveBrandMark(size: 44)
     VStack(alignment: .leading, spacing: 4) {
      Text("Eve · 夏娃").font(.headline)
      Text("以好奇探索知识，在实践中不断新生与自我进化。").font(.caption).foregroundStyle(.secondary)
     }
    }.padding(.vertical, 4)
   }
   Section("外观") {
    Picker("应用外观", selection: $appearance) {
     Text("跟随系统").tag("system")
     Text("浅色").tag("light")
     Text("深色").tag("dark")
    }.pickerStyle(.segmented).accessibilityLabel("应用外观")
   }
   Section("键盘") {
    Toggle("Enter 换行，Command-Enter 发送", isOn: $enterNewline)
    Text("默认 Enter 发送，Shift-Enter 换行。输入法候选确认及粘贴不会发送。").font(.caption).foregroundStyle(.secondary)
   }
   Section("模型连接") {
    field("baseUrl", "Base URL（包含端口和 /v1）")
    field("model", "模型公开名称 / ID")
    if !model.availableModels.isEmpty {
     Picker("可用模型", selection: Binding(get: { model.configDraft["model"] ?? "" }, set: { model.configDraft["model"] = $0 })) {
      Text("选择模型").tag("")
      ForEach(Array(Set(model.availableModels + [model.configDraft["model"] ?? ""]).filter { !$0.isEmpty }).sorted(), id: \.self) { Text($0).tag($0) }
     }
    }
    Button("测试已保存的连接并列出模型", action: model.testConnection).disabled(model.busy || model.workspace.isEmpty)
    if model.settingsDirty { Text("连接测试使用宿主已生效的配置，请先保存要测试的修改。").font(.caption).foregroundStyle(.secondary) }
    if model.connectionResult["ok"] as? Bool == true { Text("连接成功 · \(text(model.connectionResult["latencyMs"])) 毫秒 · \(model.availableModels.count) 个模型").foregroundStyle(EveTheme.accent) }
    LabeledContent("API Key", value: text(model.config["apiKey"]))
    SecureField("新密钥", text: $model.secret).textContentType(.password)
    Button("安全设置密钥", action: model.saveSecret).disabled(model.secret.isEmpty || model.busy)
    Text("仅向宿主发送设置请求，写入工作区 .eve/config.local.json（0600）。不会回显当前密钥；环境变量仍有更高优先级。").font(.caption).foregroundStyle(.secondary)
   }
   Section("预算与上下文") { ForEach(numericKeys, id: \.self) { key in field(key, numericLabels[key] ?? key) } }
   Section("技能发现") {
    Toggle("发现用户级技能", isOn: Binding(get: { model.configDraft["userSkills"] == "true" || model.configDraft["userSkills"] == "1" }, set: { model.configDraft["userSkills"] = $0 ? "true" : "false" }))
    Text("技能目录（每行一个，相对路径按工作区解析）").font(.caption)
    TextEditor(text: Binding(get: { model.configDraft["skillsDirs"] ?? "" }, set: { model.configDraft["skillsDirs"] = $0 })).frame(height: 75).font(.system(.body, design: .monospaced))
   }
   Section {
    Button("保存全部配置", action: model.saveSettings).buttonStyle(.borderedProminent).disabled(model.busy || model.workspace.isEmpty || !model.settingsDirty)
    if model.settingsDirty { Button("放弃设置编辑…") {
     let alert = NSAlert(); alert.messageText = "放弃未保存的设置编辑？"; alert.addButton(withTitle: "保留编辑"); alert.addButton(withTitle: "放弃编辑")
     if alert.runModal() == .alertSecondButtonReturn { model.updateDraft() }
    } }
    Text("仅保存编辑过的字段，再重新加载有效配置。脱敏值需完整替换后才能修改；核心验证全部预算，配置优先级与 CLI 一致。").font(.caption).foregroundStyle(.secondary)
   }
  }.formStyle(.grouped).scrollContentBackground(.hidden).background(EveTheme.canvas)
 }
 func field(_ key: String, _ label: String) -> some View {
  VStack(alignment: .leading, spacing: 4) {
   TextField(label, text: Binding(get: { model.configDraft[key] ?? "" }, set: { model.configDraft[key] = $0; model.settingsFeedback = "" })).textFieldStyle(.roundedBorder).disabled(model.workspace.isEmpty)
   Text("有效值来源：" + text(model.configSources[key]).nonEmpty(or: "宿主未提供来源；环境变量优先于本地配置")).font(.caption2).foregroundStyle(.secondary)
  }
 }
}

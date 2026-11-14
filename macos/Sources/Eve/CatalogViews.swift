import SwiftUI

struct ToolsView: View {
 @ObservedObject var model: AppModel
 var body: some View {
  ScrollView { LazyVStack(alignment: .leading, spacing: 14) {
   Text("工具由现有核心执行，文件路径限制在工作区内。").foregroundStyle(.secondary)
   ForEach(Array(model.tools.enumerated()), id: \.offset) { _, item in
    let function = object(item["function"])
    GroupBox { VStack(alignment: .leading, spacing: 8) { Label(text(function["name"]), systemImage: "wrench").font(.headline); Text(text(function["description"])).textSelection(.enabled); JSONDetails(title: "参数 schema", value: function["parameters"]) }.frame(maxWidth: .infinity, alignment: .leading).padding(8) }
   }
  }.padding() }
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
  }.padding()
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
  }.padding() }
 }
}
struct SettingsView: View {
 @ObservedObject var model: AppModel
 let numericKeys = ["maxSteps", "maxToolCalls", "timeoutMs", "maxOutputTokens", "maxToolChars", "temperature", "contextMaxChars", "contextRecentGroups", "contextSummaryChars"]
 var body: some View {
  Form {
   Section("模型连接") {
    field("baseUrl", "Base URL（包含端口和 /v1）")
    field("model", "模型")
    LabeledContent("API Key", value: text(model.config["apiKey"]))
    SecureField("新密钥", text: $model.secret).textContentType(.password)
    Button("安全设置密钥", action: model.saveSecret).disabled(model.secret.isEmpty || model.busy)
    Text("仅向宿主发送设置请求，写入工作区 .eve/config.local.json（0600）。不会回显当前密钥；环境变量仍有更高优先级。").font(.caption).foregroundStyle(.secondary)
   }
   Section("预算与上下文") { ForEach(numericKeys, id: \.self) { key in field(key, key) } }
   Section("技能发现") {
    Toggle("发现用户级技能", isOn: Binding(get: { model.configDraft["userSkills"] == "true" || model.configDraft["userSkills"] == "1" }, set: { model.configDraft["userSkills"] = $0 ? "true" : "false" }))
    Text("技能目录（每行一个，相对路径按工作区解析）").font(.caption)
    TextEditor(text: Binding(get: { model.configDraft["skillsDirs"] ?? "" }, set: { model.configDraft["skillsDirs"] = $0 })).frame(height: 75).font(.system(.body, design: .monospaced))
   }
   Section {
    Button("保存全部配置", action: model.saveSettings).buttonStyle(.borderedProminent)
    Text("仅保存编辑过的字段，再重新加载有效配置。脱敏值需完整替换后才能修改；核心验证全部预算，配置优先级与 CLI 一致。").font(.caption).foregroundStyle(.secondary)
   }
  }.formStyle(.grouped).disabled(model.busy)
 }
 func field(_ key: String, _ label: String) -> some View { TextField(label, text: Binding(get: { model.configDraft[key] ?? "" }, set: { model.configDraft[key] = $0 })).textFieldStyle(.roundedBorder) }
}

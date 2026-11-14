import SwiftUI

struct ChatView: View {
 @ObservedObject var model: AppModel
 var body: some View {
  VStack(spacing: 0) {
   HStack {
    Text(model.selectedSession.isEmpty ? "新会话 · 首次运行后自动保存" : model.selectedSession).font(.system(.caption, design: .monospaced)).textSelection(.enabled)
    Spacer()
    Button("状态", action: model.status).disabled(model.busy || model.selectedSession.isEmpty)
    Button("压缩上下文", action: model.compact).disabled(model.busy || model.selectedSession.isEmpty).help("调用核心压缩 API，保留原账本")
   }.padding(.horizontal).padding(.vertical, 10)
   if !model.context.isEmpty {
    HStack(spacing: 14) { Text("上下文 \(text(model.context["contextChars"])) / \(text(model.context["contextMaxChars"])) 字符"); Text("摘要 \(model.context["summary"] as? Bool == true ? "有" : "无") · 压缩 \(text(model.context["compactions"])) 次"); Spacer() }.font(.caption).foregroundStyle(.secondary).padding(.horizontal).padding(.bottom, 8)
   }
   ScrollView {
    VStack(alignment: .leading, spacing: 18) {
     if model.runs.isEmpty && model.latest.isEmpty { VStack(alignment: .leading, spacing: 8) { Text("在工作区中完成可验证的任务").font(.title3.bold()); Text("描述任务与允许修改的文件；可附独立验收契约。工具事件、模型结束和验收状态会分别显示。").foregroundStyle(.secondary) }.padding(.vertical, 30) }
     ForEach(Array(model.runs.enumerated()), id: \.offset) { _, run in RunCard(run: run) }
     if model.busy && !model.latest.isEmpty { RunCard(run: model.latest) }
     if !model.events.isEmpty {
      GroupBox("本次工具与运行时间线") { Timeline(events: model.events) }.frame(maxWidth: .infinity)
     }
    }.padding()
   }
   Divider()
   VStack(alignment: .leading, spacing: 10) {
    HStack {
     Button("验收契约…") { model.validateFile(suite: false) }.disabled(model.busy)
     Text(model.contractFile.isEmpty ? model.contractState : URL(fileURLWithPath: model.contractFile).lastPathComponent + " · " + model.contractState).font(.caption).foregroundStyle(.secondary).lineLimit(1).help(model.contractFile)
     if !model.contractFile.isEmpty { Button { model.contractFile = ""; model.contractState = "未选择 · 不进行独立验收"; model.autoEvolve = false } label: { Image(systemName: "xmark.circle") }.buttonStyle(.plain).disabled(model.busy) }
     Spacer()
     Toggle("失败后自动进化一次", isOn: $model.autoEvolve).toggleStyle(.checkbox).disabled(model.busy || model.contractFile.isEmpty)
    }
    if model.autoEvolve {
     Text("使用进化页的 skill / suite / 预算；仅独立验收失败后触发一次，发布仅对下一任务生效。不会重放原任务。").font(.caption).foregroundStyle(.orange)
     HStack { Text("\(model.skill.isEmpty ? "尚未选择 skill" : model.skill) · \(model.suiteFile.isEmpty ? "尚未选择 suite" : URL(fileURLWithPath: model.suiteFile).lastPathComponent) · 请求上限 \(model.maxRequests)").font(.caption); Button("配置进化") { model.page = .evolution } }
    }
    TextEditor(text: $model.prompt).font(.body).frame(minHeight: 75, maxHeight: 130).padding(5).background(.background, in: RoundedRectangle(cornerRadius: 8)).overlay(RoundedRectangle(cornerRadius: 8).stroke(.quaternary)).accessibilityLabel("任务输入").disabled(model.busy)
    HStack { Text("文件写入即时生效 · 取消不撤销已写产物").font(.caption).foregroundStyle(.secondary); Spacer(); Button("运行任务", action: model.submit).buttonStyle(.borderedProminent).keyboardShortcut(.return, modifiers: .command).disabled(model.busy || model.prompt.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || !model.connected) }
   }.padding().background(.bar)
  }
 }
}
struct RunCard: View {
 let run: JSONObject
 var body: some View {
  VStack(alignment: .leading, spacing: 12) {
   Text(text(run["prompt"])).font(.body.weight(.medium)).textSelection(.enabled)
   HStack { StatusBadge(label: "任务", value: text(run["status"])); StatusBadge(label: "模型", value: text(run["modelStatus"])); StatusBadge(label: "独立验收", value: text(object(run["verification"])["status"])) }
   if !text(run["final"]).isEmpty { Text(text(run["final"])).textSelection(.enabled).frame(maxWidth: .infinity, alignment: .leading) }
   if let error = run["error"] { Text(text(object(error)["message"])).foregroundStyle(.orange).textSelection(.enabled) }
   let assertions = objects(object(run["verification"])["assertions"])
   if !assertions.isEmpty {
    DisclosureGroup("独立文件验收 · \(assertions.count) 项") {
     ForEach(Array(assertions.enumerated()), id: \.offset) { _, a in HStack { Image(systemName: (a["passed"] as? Bool == true) ? "checkmark.circle.fill" : "xmark.circle.fill").foregroundStyle(a["passed"] as? Bool == true ? .green : .orange); Text(text(a["type"])); Text(text(a["path"])).font(.system(.caption, design: .monospaced)); Spacer(); Text(text(a["reason"])).foregroundStyle(.secondary) }.font(.caption).padding(.vertical, 3) }
    }
   }
   if let evolution = run["evolution"] { JSONDetails(title: "自动进化 · \(text(object(evolution)["status"]))", value: evolution) }
   if !objects(run["events"]).isEmpty { DisclosureGroup("已保存的运行时间线") { Timeline(events: objects(run["events"])) } }
   if run["stats"] != nil { JSONDetails(title: "请求与工具预算统计", value: run["stats"]) }
  }.padding(16).frame(maxWidth: .infinity, alignment: .leading).background(.background, in: RoundedRectangle(cornerRadius: 12)).overlay(RoundedRectangle(cornerRadius: 12).stroke(.quaternary))
 }
}
struct Timeline: View {
 let events: [JSONObject]
 var body: some View {
  VStack(alignment: .leading, spacing: 7) {
   ForEach(Array(events.enumerated()), id: \.offset) { _, event in
    HStack(alignment: .firstTextBaseline, spacing: 8) {
     Image(systemName: text(event["type"]).contains("tool") ? "wrench" : text(event["type"]) == "acceptance_end" ? "checkmark.shield" : "circle.dotted").foregroundStyle(.secondary).frame(width: 16)
     Text(text(event["type"])).font(.system(.caption, design: .monospaced))
     Text(text(event["name"])).font(.caption.bold())
     if event["ok"] != nil { Text(event["ok"] as? Bool == true ? "成功" : "失败").font(.caption).foregroundStyle(event["ok"] as? Bool == true ? .green : .orange) }
     if event["verificationStatus"] != nil { Text("验收 \(text(event["verificationStatus"]))").font(.caption) }
     Spacer()
     Text(text(event["step"])).font(.caption2).foregroundStyle(.secondary)
    }
   }
  }.frame(maxWidth: .infinity, alignment: .leading).padding(8)
 }
}

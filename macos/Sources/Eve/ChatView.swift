import SwiftUI

struct ChatView: View {
 @ObservedObject var model: AppModel
 @State private var showOptions = false
 @State private var showContext = false
 @FocusState private var editorFocused: Bool
 private var canAutoEvolve: Bool { !model.contractFile.isEmpty && !model.suiteFile.isEmpty && !model.skill.isEmpty }
 var body: some View {
  VStack(spacing: 0) {
   ScrollViewReader { proxy in
    ScrollView {
     VStack(alignment: .leading, spacing: 30) {
      if model.runs.isEmpty && model.latest.isEmpty { welcome }
      ForEach(Array(model.runs.enumerated()), id: \.offset) { _, run in RunCard(run: run) }
      if model.busy && text(model.latest["status"]) == "running" { RunCard(run: model.latest) }
      if model.busy && text(model.latest["status"]) == "running" && !model.events.isEmpty {
       DisclosureGroup("本次工具与运行时间线 · \(model.events.count)") { Timeline(events: model.events) }.font(.caption).foregroundStyle(.secondary)
      }
      Color.clear.frame(height: 1).id("bottom")
     }.frame(maxWidth: EveTheme.contentWidth).frame(maxWidth: .infinity).padding(.horizontal, 28).padding(.top, 26).padding(.bottom, 12)
    }.onChange(of: model.events.count) { _, _ in if model.busy { withAnimation { proxy.scrollTo("bottom", anchor: .bottom) } } }
     .onChange(of: model.runs.count) { _, _ in proxy.scrollTo("bottom", anchor: .bottom) }
   }
   composer.frame(maxWidth: EveTheme.contentWidth).frame(maxWidth: .infinity).padding(.horizontal, 18).padding(.bottom, 16).padding(.top, 8)
  }
 }
 private var welcome: some View {
  VStack(alignment: .center, spacing: 18) {
   EveAvatar(size: 88)
   Text("一起把想法变成现实").font(.system(size: 25, weight: .medium))
   Text("从一个问题开始，或在工作区里完成一项任务。").font(.system(size: 13)).foregroundStyle(.secondary)
   VStack(spacing: 8) {
    suggestion("了解这个工作区", prompt: "请只读查看工作区，概述项目结构与主要入口，不修改任何文件。", symbol: "folder")
    suggestion("梳理下一步", prompt: "请只读分析当前项目，列出值得优先处理的问题及理由，不修改文件。", symbol: "checklist")
    suggestion("设计一个可验证的任务", prompt: "帮我把下面的想法整理成有明确范围和验收标准的任务：\n", symbol: "checkmark.shield")
   }.frame(maxWidth: 390).padding(.top, 8)
  }.frame(maxWidth: .infinity).padding(.top, 70).padding(.bottom, 44)
 }
 private func suggestion(_ title: String, prompt: String, symbol: String) -> some View {
  Button { model.prompt = prompt; editorFocused = true } label: {
   HStack { Label(title, systemImage: symbol); Spacer(); Image(systemName: "arrow.up.left").font(.caption).foregroundStyle(.tertiary) }
    .font(.system(size: 12)).padding(12).background(EveTheme.sidebar.opacity(0.65), in: RoundedRectangle(cornerRadius: 10))
  }.buttonStyle(.plain).disabled(model.busy).help("填入草稿，不会自动发送")
 }
 private var composer: some View {
  VStack(alignment: .leading, spacing: 5) {
   ZStack(alignment: .topLeading) {
    if model.prompt.isEmpty { Text("输入消息…").foregroundStyle(.tertiary).padding(.horizontal, 5).padding(.top, 8).allowsHitTesting(false) }
    TextEditor(text: $model.prompt).font(.system(size: 14)).scrollContentBackground(.hidden).frame(height: 86).focused($editorFocused).accessibilityLabel("任务输入").disabled(model.busy)
   }.padding(.horizontal, 12).padding(.top, 8)
   HStack(spacing: 5) {
    QuietIconButton(title: "验收契约…", symbol: model.contractFile.isEmpty ? "paperclip" : "paperclip.badge.ellipsis") { model.validateFile(suite: false) }.disabled(model.busy)
    QuietIconButton(title: "选择工作区…", symbol: "folder", action: model.chooseWorkspace).disabled(model.busy || !model.connected).help(model.workspace)
    QuietIconButton(title: "任务选项", symbol: "slider.horizontal.3") { showOptions.toggle() }
     .popover(isPresented: $showOptions, arrowEdge: .top) { options.padding(20).frame(width: 390) }
    QuietIconButton(title: "上下文与会话状态", symbol: "chart.pie") { showContext.toggle() }
     .popover(isPresented: $showContext, arrowEdge: .top) { contextDetails.padding(20).frame(width: 370) }
    Button { model.page = .settings } label: {
     HStack(spacing: 5) { Image(systemName: "cpu"); Text(text(model.config["model"]).isEmpty ? "配置模型" : String(text(model.config["model"]).split(separator: "/").last ?? "")).lineLimit(1).truncationMode(.middle) }.font(.system(size: 11)).foregroundStyle(.secondary)
    }.buttonStyle(.plain).help("查看模型与预算设置").accessibilityLabel("模型与预算设置")
    Spacer(minLength: 4)
    if !model.contractFile.isEmpty { Image(systemName: "checkmark.shield").foregroundStyle(EveTheme.accent).help(model.contractState) }
    Text("⌘ ↵").font(.system(size: 10)).foregroundStyle(.tertiary)
    if model.busy {
     Button(action: model.cancel) { Image(systemName: "stop.fill").font(.system(size: 11)).frame(width: 30, height: 30) }.buttonStyle(.plain).background(EveTheme.selection, in: Circle()).disabled(model.cancelRequested).accessibilityLabel("取消运行").help("取消运行；等待写入收尾")
    } else {
     Button(action: model.submit) { Image(systemName: "arrow.up").font(.system(size: 14, weight: .semibold)).foregroundStyle(.white).frame(width: 30, height: 30).background(EveTheme.accent, in: Circle()) }
      .buttonStyle(.plain).keyboardShortcut(.return, modifiers: .command).disabled(model.prompt.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || !model.connected).opacity(model.prompt.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? 0.45 : 1).accessibilityLabel("运行任务").help("运行任务（Command-Return）")
    }
   }.padding(.horizontal, 12).padding(.bottom, 11)
  }.background(EveTheme.surface, in: RoundedRectangle(cornerRadius: 20))
   .overlay(RoundedRectangle(cornerRadius: 20).stroke(EveTheme.separator, lineWidth: 1))
   .shadow(color: .black.opacity(0.035), radius: 9, y: 3)
 }
 private var options: some View {
  VStack(alignment: .leading, spacing: 14) {
   Text("任务选项").font(.headline)
   HStack { Button("验收契约…") { model.validateFile(suite: false) }; Spacer(); if !model.contractFile.isEmpty { Button("清除") { model.contractFile = ""; model.contractState = "未选择 · 不进行独立验收"; model.autoEvolve = false } } }.disabled(model.busy)
   Text(model.contractFile.isEmpty ? model.contractState : URL(fileURLWithPath: model.contractFile).lastPathComponent + " · " + model.contractState).font(.caption).foregroundStyle(.secondary)
   Divider()
   Toggle("失败后自动进化一次", isOn: $model.autoEvolve).accessibilityLabel("失败后自动进化一次").disabled(model.busy || !canAutoEvolve)
   Text(canAutoEvolve ? "只在独立验收失败后触发，使用进化页的 skill、suite 与显式预算；不重放原任务。" : "请先选择有效契约，并在进化页配置 skill、suite 和显式预算。").font(.caption).foregroundStyle(.secondary)
   Text("\(model.skill.isEmpty ? "未选择 skill" : model.skill) · \(model.suiteFile.isEmpty ? "未选择 suite" : URL(fileURLWithPath: model.suiteFile).lastPathComponent)").font(.caption).foregroundStyle(.secondary)
   Text("请求上限 \(model.maxRequests) · \(model.evolutionTimeout) ms").font(.caption).foregroundStyle(.secondary)
   Button("配置进化来源与预算") { showOptions = false; model.page = .evolution }
   Divider()
   Text("单任务最多 \(text(model.config["maxSteps"])) 步 · \(text(model.config["maxToolCalls"])) 次工具调用\n输出上限 \(text(model.config["maxOutputTokens"])) tokens").font(.caption).foregroundStyle(.secondary)
   Text("文件写入即时生效，取消不会撤销已写产物。").font(.caption).foregroundStyle(.tertiary)
  }
 }
 private var contextDetails: some View {
  VStack(alignment: .leading, spacing: 12) {
   Text("会话与上下文").font(.headline)
   Text(model.selectedSession.isEmpty ? "首次运行后自动保存会话" : model.selectedSession).font(.system(.caption, design: .monospaced)).textSelection(.enabled)
   if !model.context.isEmpty {
    Text("上下文 \(text(model.context["contextChars"])) / \(text(model.context["contextMaxChars"])) 字符").font(.caption)
    Text("摘要 \(model.context["summary"] as? Bool == true ? "有" : "无") · 压缩 \(text(model.context["compactions"])) 次").font(.caption).foregroundStyle(.secondary)
   }
   HStack { Button("状态", action: model.status); Button("压缩上下文", action: model.compact).help("调用核心压缩 API，保留原账本；会产生模型请求") }.disabled(model.busy || model.selectedSession.isEmpty)
  }
 }
}
struct RunCard: View {
 let run: JSONObject
 var body: some View {
  VStack(alignment: .leading, spacing: 11) {
   HStack {
    Spacer(minLength: 70)
    Text(text(run["prompt"])).font(.system(size: 14)).lineSpacing(4).textSelection(.enabled).padding(.horizontal, 16).padding(.vertical, 12).background(EveTheme.userBubble, in: RoundedRectangle(cornerRadius: 17))
   }.padding(.bottom, 9)
   HStack(spacing: 7) { EveAvatar(size: 24); Text("Eve").font(.system(size: 11, weight: .medium)).foregroundStyle(.secondary) }
   ViewThatFits(in: .horizontal) { HStack { StatusBadge(label: "任务", value: text(run["status"])); StatusBadge(label: "模型", value: text(run["modelStatus"])); StatusBadge(label: "独立验收", value: text(object(run["verification"])["status"])) }; VStack(alignment: .leading) { StatusBadge(label: "任务", value: text(run["status"])); StatusBadge(label: "模型", value: text(run["modelStatus"])); StatusBadge(label: "独立验收", value: text(object(run["verification"])["status"])) } }
   if !text(run["final"]).isEmpty { Text(text(run["final"])).font(.system(size: 14)).lineSpacing(5).textSelection(.enabled).frame(maxWidth: .infinity, alignment: .leading) }
   if let error = run["error"] { Text(text(object(error)["message"])).foregroundStyle(.orange).textSelection(.enabled) }
   let assertions = objects(object(run["verification"])["assertions"])
   if !assertions.isEmpty {
    DisclosureGroup("独立文件验收 · \(assertions.count) 项") {
     ForEach(Array(assertions.enumerated()), id: \.offset) { _, a in HStack { Image(systemName: (a["passed"] as? Bool == true) ? "checkmark.circle.fill" : "xmark.circle.fill").foregroundStyle(a["passed"] as? Bool == true ? .green : .orange); Text(text(a["type"])); Text(text(a["path"])).font(.system(.caption, design: .monospaced)); Spacer(); Text(text(a["reason"])).foregroundStyle(.secondary) }.font(.caption).padding(.vertical, 3) }
    }
   }
   if let evolution = run["evolution"] { JSONDetails(title: "自动进化 · \(text(object(evolution)["status"]))", value: evolution) }
   if !objects(run["events"]).isEmpty { DisclosureGroup("已保存的运行时间线") { Timeline(events: objects(run["events"])) }.font(.caption).foregroundStyle(.secondary).accessibilityLabel("已保存的运行时间线") }
   if run["stats"] != nil { JSONDetails(title: "请求与工具预算统计", value: run["stats"]) }
  }.frame(maxWidth: .infinity, alignment: .leading)
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

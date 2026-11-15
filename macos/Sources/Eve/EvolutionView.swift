import SwiftUI

struct EvolutionView: View {
 @ObservedObject var model: AppModel

 private var failedRuns: [JSONObject] {
  model.sourceRuns.filter { text(object($0["verification"])["status"]) == "failed" && !text($0["id"]).isEmpty }
 }
 private var failedRunIDs: [String] { failedRuns.map { text($0["id"]) } }
 private var selectedRun: JSONObject? { failedRuns.first { text($0["id"]) == model.sourceRun } }
 private var sourceReady: Bool { !model.sourceSession.isEmpty && selectedRun != nil }
 private var publishedSkills: [String] { object(model.capabilities["active"]).keys.sorted() }
 private var skillReady: Bool { publishedSkills.contains(model.skill) }
 private var budgetIssue: String? {
  guard let requests = Int(model.maxRequests), (1...100).contains(requests) else { return "请求上限须为 1–100 次的整数。" }
  guard let timeout = Int(model.evolutionTimeout), (1...1800000).contains(timeout) else { return "总超时须为 1–1,800,000 毫秒的整数。" }
  return nil
 }
 private var canSubmit: Bool { sourceReady && skillReady && !model.suiteFile.isEmpty && budgetIssue == nil && !model.busy }
 private var nextAction: String {
  if !sourceReady { return "请先选择一条真实验收失败的运行。" }
  if !skillReady { return "请选择当前已发布的技能。" }
  if model.suiteFile.isEmpty { return "请选择并验证独立验证集。" }
  return budgetIssue ?? "准备就绪；开始后会发起模型请求并保留实验记录。"
 }

 var body: some View {
  ScrollView {
   VStack(alignment: .leading, spacing: 18) {
    Text("改进一次验收失败").font(.title2.bold())
    Text("选择真实失败，生成一个技能候选，再用独立验证集对比当前版本与候选版本。这会修改技能内容，不会训练模型权重，也不会自动重放原任务。")
     .foregroundStyle(.secondary)
    sourceStep
    preparationStep
    submissionStep
    if !model.evolutionResult.isEmpty { ExperimentCard(record: model.evolutionResult, title: "本次结果") }
    HStack {
     Text("实验记录").font(.headline)
     Spacer()
     Button("刷新", action: model.refresh).disabled(model.busy)
    }
    if model.experiments.isEmpty {
     Text("尚无实验。失败和记录异常也会保留在宿主私有账本中。").foregroundStyle(.secondary)
    }
    ForEach(Array(model.experiments.reversed().enumerated()), id: \.offset) { _, record in
     ExperimentCard(record: record, title: text(record["experimentId"]).nonEmpty(or: text(record["id"])).nonEmpty(or: "实验记录"))
    }
   }
   .padding(24).frame(maxWidth: EveTheme.contentWidth).frame(maxWidth: .infinity, alignment: .top)
  }
  .onAppear { reconcileSourceRun() }
  .onChange(of: failedRunIDs) { _, _ in reconcileSourceRun() }
  .onChange(of: model.sourceRun) { _, _ in reconcileSourceRun() }
  .onChange(of: model.sourceSession) { _, _ in reconcileSourceRun() }
 }

 private var sourceStep: some View {
  GroupBox("步骤 1 · 选择真实验收失败") {
   VStack(alignment: .leading, spacing: 12) {
    Picker("来源会话", selection: Binding(get: { model.sourceSession }, set: { model.loadSource($0) })) {
     Text("请选择会话").tag("")
     ForEach(Array(model.sessions.enumerated()), id: \.offset) { _, session in
      Text(model.sessionTitle(text(session["id"]))).tag(text(session["id"]))
     }
    }
    if model.sessions.isEmpty {
     Text("还没有可选会话。请先在聊天中完成一个带验收契约的任务；出现真实验收失败后，再来改进。").foregroundStyle(.secondary)
    } else if model.sourceSession.isEmpty {
     Text("先选择会话，再从中选择验收失败的运行。普通执行失败不作为改进来源。").font(.caption).foregroundStyle(.secondary)
    } else if failedRuns.isEmpty {
     Text(model.busy ? "正在读取来源运行…" : "此会话暂无真实验收失败。请先完成带验收契约的任务，或选择其他会话。")
      .foregroundStyle(.secondary)
    } else {
     Picker("验收失败的运行", selection: Binding(get: { sourceReady ? model.sourceRun : "" }, set: { model.sourceRun = $0 })) {
      Text("请选择运行").tag("")
      ForEach(Array(failedRuns.enumerated()), id: \.offset) { _, run in
       Text("\(text(run["id"])) · 验收失败 · \(String(text(run["prompt"]).prefix(70)))").tag(text(run["id"]))
      }
     }
     if let run = selectedRun {
      Text(text(run["prompt"])).font(.caption).foregroundStyle(.secondary).lineLimit(3).textSelection(.enabled)
     }
     Text("来源须实际加载所选技能的当前发布版本；开始前核心会核验原始契约与版本证据。").font(.caption).foregroundStyle(.secondary)
    }
   }.frame(maxWidth: .infinity, alignment: .leading).padding(10)
  }.disabled(model.busy)
 }

 private var preparationStep: some View {
  GroupBox("步骤 2 · 准备技能与验证集") {
   VStack(alignment: .leading, spacing: 12) {
    if publishedSkills.isEmpty {
     Text("尚无已发布技能。请先在能力管理中导入可信技能作为基线，再选择实际使用该版本的失败运行。")
      .foregroundStyle(.secondary)
     Button("前往能力管理") { model.page = .capabilities }
    } else {
     VStack(alignment: .leading, spacing: 12) {
      Picker("要改进的技能", selection: Binding(get: { skillReady ? model.skill : "" }, set: { model.skill = $0 })) {
       Text("请选择已发布技能").tag("")
       ForEach(publishedSkills, id: \.self) { name in Text(name).tag(name) }
      }
      Text("描述纠正（可选）").font(.subheadline.bold())
      Text("写下失败原因与期望的技能行为。纠正会发送给候选生成器，请仅填写可公开内容；不会附加原始契约或验证集文件内容。")
       .font(.caption).foregroundStyle(.secondary)
      TextEditor(text: $model.correction).frame(height: 90).padding(4)
       .overlay(RoundedRectangle(cornerRadius: 6).stroke(.quaternary))
       .accessibilityLabel("纠正说明")
      HStack {
       Button("选择并验证验证集…") { model.validateFile(suite: true) }
       Text(model.suiteFile.isEmpty ? "尚未选择验证集" : model.suiteState.replacingOccurrences(of: "cases", with: "个用例").replacingOccurrences(of: "suite", with: "验证集"))
        .font(.caption).foregroundStyle(.secondary)
      }
      if !model.suiteFile.isEmpty { Text(model.suiteFile).font(.caption).textSelection(.enabled) }
      Text("请自行准备独立验证集文件。选择后沿用现有格式与预算验证，开始时冻结同一验证集做对照评测；不会自动创建验证集或读取隐藏文件。")
       .font(.caption).foregroundStyle(.secondary)
     }.disabled(!sourceReady)
    }
   }.frame(maxWidth: .infinity, alignment: .leading).padding(10)
  }.disabled(model.busy)
 }

 private var submissionStep: some View {
  GroupBox("步骤 3 · 确认并开始") {
   VStack(alignment: .leading, spacing: 12) {
    Text(sourceReady ? "来源：\(model.sessionTitle(model.sourceSession)) · \(model.sourceRun)" : "来源：待选择验收失败的运行")
    Text("技能：\(skillReady ? model.skill : "待选择") · 验证集：\(model.suiteFile.isEmpty ? "待选择并验证" : "已选择并验证")")
    Text("最多生成一个技能候选，并分别评测当前版本与候选版本。只有通过独立评测的候选才可发布；小样本通过不代表所有任务都会改善。")
     .font(.caption).foregroundStyle(.secondary)
    Text("请求上限：\(model.maxRequests) 次 · 总超时：\(model.evolutionTimeout) 毫秒")
     .font(.caption).foregroundStyle(.secondary)
    DisclosureGroup("高级预算") {
     VStack(alignment: .leading, spacing: 10) {
      LabeledContent("模型请求上限（1–100 次）") {
       TextField("整数", text: $model.maxRequests)
        .accessibilityLabel("模型请求上限，1 至 100 次，整数")
      }
      LabeledContent("总超时（1–1,800,000 毫秒）") {
       TextField("整数", text: $model.evolutionTimeout)
        .accessibilityLabel("总超时，1 至 1800000 毫秒，整数")
      }
      Text("请求上限包括候选生成与两组评测，必须覆盖验证集最坏预算；不足时核心会在付费请求前拒绝。1,000 毫秒 = 1 秒，总超时最多 30 分钟。")
       .font(.caption).foregroundStyle(.secondary)
     }.textFieldStyle(.roundedBorder).padding(.top, 8)
    }
    if let issue = budgetIssue { Text(issue).font(.caption).foregroundStyle(.orange) }
    Toggle("评测通过后自动发布技能", isOn: $model.autoPromote)
    Text(model.autoPromote
     ? "通过独立评测并满足发布约束后，将更新该技能的当前发布版本，后续任务会使用新版本。原任务不会自动重放。"
     : "仅生成候选并评测，当前发布版本不变。评测通过后，可前往能力管理手动发布；原任务不会自动重放。")
     .font(.caption).foregroundStyle(.secondary)
    HStack {
     Button("生成候选并评测") {
      guard canSubmit else { return }
      model.evolve()
     }.buttonStyle(.borderedProminent).disabled(!canSubmit)
     Text(nextAction).font(.caption).foregroundStyle(.secondary)
    }
   }.frame(maxWidth: .infinity, alignment: .leading).padding(10)
  }.disabled(model.busy)
 }

 private func reconcileSourceRun() {
  let valid = model.sourceSession.isEmpty ? "" : (failedRunIDs.contains(model.sourceRun) ? model.sourceRun : failedRunIDs.last ?? "")
  if model.sourceRun != valid { model.sourceRun = valid }
 }
}

private func evolutionStatusLabel(_ value: String) -> String {
 switch value {
 case "reserved": "已预留预算"
 case "evaluating": "评测中"
 case "evaluated": "已评测"
 case "passed": "通过"
 case "completed": "已完成"
 case "promoted", "active": "已发布"
 case "failed": "失败"
 case "rejected": "已拒绝"
 case "cancelled": "已取消"
 case "interrupted": "已中断"
 case "not_checked": "未验收"
 case "not_requested": "未请求验收"
 case "not_triggered": "未触发"
 default: "未知状态"
 }
}

struct ExperimentCard: View {
 let record: JSONObject
 let title: String
 private var cases: [JSONObject] {
  let evaluated = objects(object(record["evaluation"])["cases"])
  return evaluated.isEmpty ? objects(record["cases"]) : evaluated
 }
 var body: some View {
  GroupBox {
   VStack(alignment: .leading, spacing: 10) {
    HStack {
     Text(title).font(.headline).textSelection(.enabled)
     Spacer()
     Text("状态：\(evolutionStatusLabel(text(record["status"])))").font(.caption).foregroundStyle(.secondary)
    }
    if let error = record["error"] { Text(errorMessage(error)).font(.caption).foregroundStyle(.orange) }
    if let error = record["recording_error"] { Text("发布已提交，但记录保存异常。\(errorMessage(error))").font(.caption).foregroundStyle(.orange) }
    if !cases.isEmpty {
     HStack {
      Text("验证用例").frame(maxWidth: .infinity, alignment: .leading)
      Text("当前版本").frame(width: 160)
      Text("候选版本").frame(width: 160)
     }.font(.caption.bold())
     ForEach(Array(cases.enumerated()), id: \.offset) { _, item in
      HStack {
       Text(text(item["id"])).frame(maxWidth: .infinity, alignment: .leading)
       score(object(item["baseline"])).frame(width: 160)
       score(object(item["candidate"])).frame(width: 160)
      }
     }
     Text("当前版本通过 \(cases.filter { object($0["baseline"])["passed"] as? Bool == true }.count)/\(cases.count) · 候选版本通过 \(cases.filter { object($0["candidate"])["passed"] as? Bool == true }.count)/\(cases.count)")
      .font(.caption.bold())
    }
    JSONDetails(title: "高级：原始记录、预算与版本证据", value: record)
   }.padding(10).frame(maxWidth: .infinity, alignment: .leading)
  }
 }
 private func errorMessage(_ error: Any) -> String {
  if let message = error as? String { return message }
  return text(object(error)["message"]).nonEmpty(or: "详情请展开高级记录查看。")
 }
 func score(_ arm: JSONObject) -> some View {
  Text(arm.isEmpty ? "尚无结果" : arm["certain"] as? Bool == false ? "不确定 · \(evolutionStatusLabel(text(arm["status"])))" : arm["passed"] as? Bool == true ? "通过" : "失败")
   .font(.caption).foregroundStyle(arm["passed"] as? Bool == true ? .green : .orange)
 }
}

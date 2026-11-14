import SwiftUI
struct EvolutionView: View {
 @ObservedObject var model: AppModel
 var body: some View {
  ScrollView { VStack(alignment: .leading, spacing: 18) {
   Text("从真实契约失败的运行生成一个候选，用冻结 suite 做 baseline / candidate 对照；只有通过独立评测的候选才能发布。").foregroundStyle(.secondary)
   GroupBox("来源与预算") { VStack(alignment: .leading, spacing: 12) {
    Picker("Source session", selection: Binding(get: { model.sourceSession }, set: { model.loadSource($0) })) {
     Text("请选择").tag("")
     ForEach(Array(model.sessions.enumerated()), id: \.offset) { _, s in Text(model.sessionTitle(text(s["id"]))).tag(text(s["id"])) }
    }
    Picker("Source run", selection: $model.sourceRun) {
     Text("请选择").tag("")
     ForEach(Array(model.sourceRuns.enumerated()), id: \.offset) { _, r in Text("\(text(r["id"])) · \(text(r["status"])) · 验收 \(text(object(r["verification"])["status"]))").tag(text(r["id"])) }
    }
    Picker("Skill", selection: $model.skill) { Text("请选择").tag(""); ForEach(object(model.capabilities["active"]).keys.sorted(), id: \.self) { name in Text(name).tag(name) } }
    HStack { Button("选择并验证 suite…") { model.validateFile(suite: true) }; Text(model.suiteState).font(.caption).foregroundStyle(.secondary) }
    if !model.suiteFile.isEmpty { Text(model.suiteFile).font(.caption).textSelection(.enabled) }
    Text("公开纠正（不会加入契约 / suite 文件内容）").font(.caption)
    TextEditor(text: $model.correction).frame(height: 80).padding(4).overlay(RoundedRectangle(cornerRadius: 6).stroke(.quaternary))
    HStack { TextField("maxRequests（显式上限）", text: $model.maxRequests); TextField("timeoutMs", text: $model.evolutionTimeout) }.textFieldStyle(.roundedBorder)
    Toggle("评测通过后自动发布", isOn: $model.autoPromote)
    HStack { Button("开始进化", action: model.evolve).buttonStyle(.borderedProminent).disabled(model.sourceRun.isEmpty || model.skill.isEmpty || model.suiteFile.isEmpty); Text("请求上限必须覆盖 suite 最坏预算；最多一个候选，不重放原任务。").font(.caption).foregroundStyle(.secondary) }
   }.padding(10) }.disabled(model.busy)
   if !model.evolutionResult.isEmpty { ExperimentCard(record: model.evolutionResult, title: "本次结果") }
   HStack { Text("实验记录").font(.headline); Spacer(); Button("刷新", action: model.refresh).disabled(model.busy) }
   if model.experiments.isEmpty { Text("尚无实验。失败和记录异常也会保留在宿主私有账本中。").foregroundStyle(.secondary) }
   ForEach(Array(model.experiments.reversed().enumerated()), id: \.offset) { _, r in ExperimentCard(record: r, title: text(r["experimentId"])) }
  }.padding(24).frame(maxWidth: EveTheme.contentWidth).frame(maxWidth: .infinity, alignment: .top) }
 }
}
struct ExperimentCard: View {
 let record: JSONObject
 let title: String
 var body: some View {
  GroupBox { VStack(alignment: .leading, spacing: 10) {
   HStack { Text(title).font(.headline).textSelection(.enabled); Spacer(); StatusBadge(label: "状态", value: text(record["status"])) }
   if let error = record["error"] { Text(pretty(error)).font(.caption).foregroundStyle(.orange) }
   if let error = record["recording_error"] { Text("发布已提交，但记录保存异常。\(pretty(error))").font(.caption).foregroundStyle(.orange) }
   let cases = objects(object(record["evaluation"])["cases"])
   if !cases.isEmpty {
    HStack { Text("Case").frame(maxWidth: .infinity, alignment: .leading); Text("Baseline").frame(width: 160); Text("Candidate").frame(width: 160) }.font(.caption.bold())
    ForEach(Array(cases.enumerated()), id: \.offset) { _, c in HStack { Text(text(c["id"])).frame(maxWidth: .infinity, alignment: .leading); score(object(c["baseline"])).frame(width: 160); score(object(c["candidate"])).frame(width: 160) } }
    Text("Baseline \(cases.filter { object($0["baseline"])["passed"] as? Bool == true }.count)/\(cases.count) · Candidate \(cases.filter { object($0["candidate"])["passed"] as? Bool == true }.count)/\(cases.count)").font(.caption.bold())
   }
   JSONDetails(title: "预算与版本记录", value: record)
  }.padding(10).frame(maxWidth: .infinity, alignment: .leading) }
 }
 func score(_ arm: JSONObject) -> some View { Text(arm["certain"] as? Bool == false ? "不确定 · \(text(arm["status"]))" : arm["passed"] as? Bool == true ? "通过" : "失败").font(.caption).foregroundStyle(arm["passed"] as? Bool == true ? .green : .orange) }
}

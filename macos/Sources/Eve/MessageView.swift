import SwiftUI
import AppKit
import EveProtocol

func copyText(_ value: String) { NSPasteboard.general.clearContents(); NSPasteboard.general.setString(value, forType: .string) }

struct MessageView: View {
 let message: String
 var body: some View {
  VStack(alignment: .leading, spacing: 12) {
   ForEach(MessageBlocks.parse(message)) { block in
    switch block.kind {
    case .prose:
     MarkdownProse(text: block.text)
    case .code(let language):
     VStack(alignment: .leading, spacing: 8) {
      HStack { Text(language.isEmpty ? "代码" : language).font(.caption).foregroundStyle(.secondary); Spacer(); Button("复制代码") { copyText(block.text) }.buttonStyle(.borderless).font(.caption) }
      ScrollView(.horizontal) { Text(block.text).font(.system(size: 12, design: .monospaced)).textSelection(.enabled).fixedSize(horizontal: true, vertical: false).padding(.bottom, 6) }
     }.padding(12).background(EveTheme.sidebar, in: RoundedRectangle(cornerRadius: 10))
    case .table:
     VStack(alignment: .leading, spacing: 5) {
      Text("表格 · 保留原始列内容，可横向滚动").font(.caption2).foregroundStyle(.secondary)
      ScrollView(.horizontal) { Text(block.text).font(.system(size: 12, design: .monospaced)).textSelection(.enabled).fixedSize(horizontal: true, vertical: false).padding(.bottom, 6) }
     }
    }
   }
  }
 }
}

private struct MarkdownProse: View {
 let text: String
 private func inline(_ value: String) -> Text {
  Text((try? AttributedString(markdown: value, options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace))) ?? AttributedString(value))
 }
 var body: some View {
  VStack(alignment: .leading, spacing: 5) {
   ForEach(Array(text.components(separatedBy: "\n").enumerated()), id: \.offset) { _, line in
    let trimmed = line.trimmingCharacters(in: .whitespaces)
    let hashes = trimmed.prefix(while: { $0 == "#" }).count
    if (1...6).contains(hashes), trimmed.dropFirst(hashes).first == " " {
     inline(String(trimmed.dropFirst(hashes + 1))).font(.system(size: hashes == 1 ? 23 : hashes == 2 ? 20 : 17, weight: .semibold)).padding(.top, 7)
    } else if ["---", "***", "___"].contains(trimmed) {
     Divider().padding(.vertical, 6)
    } else if trimmed.hasPrefix("> ") {
     HStack(alignment: .top, spacing: 10) { Rectangle().fill(EveTheme.accent.opacity(0.5)).frame(width: 3); inline(String(trimmed.dropFirst(2))).foregroundStyle(.secondary) }.fixedSize(horizontal: false, vertical: true).padding(.vertical, 3)
    } else if trimmed.hasPrefix("- ") || trimmed.hasPrefix("* ") || trimmed.hasPrefix("+ ") {
     HStack(alignment: .firstTextBaseline, spacing: 9) { Text("•"); inline(String(trimmed.dropFirst(2))).frame(maxWidth: .infinity, alignment: .leading) }.padding(.leading, CGFloat(line.prefix(while: { $0 == " " }).count) * 3)
    } else if let prefix = trimmed.range(of: #"^\d+[.)]\s+"#, options: .regularExpression) {
     HStack(alignment: .firstTextBaseline, spacing: 9) { Text(String(trimmed[prefix]).trimmingCharacters(in: .whitespaces)).monospacedDigit(); inline(String(trimmed[prefix.upperBound...])).frame(maxWidth: .infinity, alignment: .leading) }
    } else if trimmed.isEmpty {
     Color.clear.frame(height: 4)
    } else {
     inline(line).frame(maxWidth: .infinity, alignment: .leading)
    }
   }
  }.font(.system(size: 14)).lineSpacing(5).textSelection(.enabled).frame(maxWidth: .infinity, alignment: .leading)
 }
}

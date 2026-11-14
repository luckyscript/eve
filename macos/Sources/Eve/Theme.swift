import SwiftUI
import AppKit

/// Semantic surfaces keep contrast in both Aqua and Dark Aqua.
enum EveTheme {
 static let canvas = color(light: 0xffffff, dark: 0x1e2021)
 static let sidebar = color(light: 0xf5f6f5, dark: 0x27292a)
 static let surface = color(light: 0xffffff, dark: 0x292c2d)
 static let selection = color(light: 0xe7eae8, dark: 0x373d3c)
 static let userBubble = color(light: 0xe4efec, dark: 0x304440)
 static let accent = color(light: 0x47776d, dark: 0x8cbcaf)
 static let separator = color(light: 0xe5e8e6, dark: 0x3a3e3c)
 static let contentWidth: CGFloat = 900
 static func color(light: Int, dark: Int) -> Color {
  Color(nsColor: NSColor(name: nil) { appearance in
   let hex = appearance.bestMatch(from: [.aqua, .darkAqua]) == .darkAqua ? dark : light
   return NSColor(srgbRed: CGFloat((hex >> 16) & 255) / 255, green: CGFloat((hex >> 8) & 255) / 255, blue: CGFloat(hex & 255) / 255, alpha: 1)
  })
 }
}

struct QuietIconButton: View {
 let title: String
 let symbol: String
 let action: () -> Void
 var body: some View {
  Button(action: action) { Image(systemName: symbol).font(.system(size: 13, weight: .medium)).frame(width: 28, height: 28).contentShape(RoundedRectangle(cornerRadius: 7)) }
   .buttonStyle(.plain).foregroundStyle(.secondary).accessibilityLabel(title).help(title)
 }
}

struct EveGroupBoxStyle: GroupBoxStyle {
 func makeBody(configuration: Configuration) -> some View {
  VStack(alignment: .leading, spacing: 12) {
   configuration.label.font(.system(size: 13, weight: .semibold))
   configuration.content
  }.padding(16).frame(maxWidth: .infinity, alignment: .leading)
   .background(EveTheme.surface, in: RoundedRectangle(cornerRadius: 14))
   .overlay(RoundedRectangle(cornerRadius: 14).stroke(EveTheme.separator, lineWidth: 1))
 }
}

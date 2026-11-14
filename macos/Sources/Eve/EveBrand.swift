import SwiftUI
import AppKit

/// SwiftPM resolves the development bundle; packaged apps resolve their own Resources.
/// Avoid Bundle.module's generated absolute build-directory fallback in shipped executables.
enum EveBrand {
 static var bundle: Bundle {
  if let url = Bundle.main.resourceURL?.appendingPathComponent("Eve_Eve.bundle"),
     let bundle = Bundle(url: url) { return bundle }
  return Bundle.module
 }
 static func image(_ name: String, extension ext: String = "png") -> NSImage {
  guard let url = bundle.url(forResource: name, withExtension: ext), let image = NSImage(contentsOf: url) else {
   preconditionFailure("Missing Eve brand resource: \(name).\(ext)")
  }
  return image
 }
 static let logo = image("eve-logo")
 static let avatar = image("eve-avatar")
 static let icon = image("Eve", extension: "icns")
}

struct EveBrandMark: View {
 var size: CGFloat = 32
 var body: some View {
  Image(nsImage: EveBrand.logo).resizable().interpolation(.high).scaledToFit()
   .padding(size * 0.17).frame(width: size, height: size)
   .background(EveTheme.color(light: 0xf7f3eb, dark: 0xc6d9cc), in: RoundedRectangle(cornerRadius: size * 0.25))
   .accessibilityLabel("Eve 标志 · 新生之叶")
 }
}

struct EveAvatar: View {
 var size: CGFloat = 24
 var body: some View {
  Image(nsImage: EveBrand.avatar).resizable().interpolation(.high).scaledToFill()
   .frame(width: size, height: size).clipShape(Circle())
   .overlay(Circle().strokeBorder(EveTheme.separator.opacity(0.65), lineWidth: 0.5))
   .accessibilityLabel("Eve · 夏娃头像")
 }
}

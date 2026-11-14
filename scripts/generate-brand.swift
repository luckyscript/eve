#!/usr/bin/env swift
// Local, deterministic derivatives of the approved originals. No network or image generation.
import AppKit
import ImageIO

let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
let brand = root.appendingPathComponent("assets/brand")
let resources = root.appendingPathComponent("macos/Sources/Eve/Resources")
let fm = FileManager.default
func load(_ name: String) throws -> CGImage {
 let url = brand.appendingPathComponent(name)
 guard let source = CGImageSourceCreateWithURL(url as CFURL, nil), let image = CGImageSourceCreateImageAtIndex(source, 0, nil) else { throw NSError(domain: "Brand", code: 1) }
 return image
}
func context(_ size: Int) -> CGContext {
 CGContext(data: nil, width: size, height: size, bitsPerComponent: 8, bytesPerRow: size * 4, space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
}
func save(_ image: CGImage, _ url: URL) {
 let dest = CGImageDestinationCreateWithURL(url as CFURL, "public.png" as CFString, 1, nil)!
 CGImageDestinationAddImage(dest, image, nil)
 precondition(CGImageDestinationFinalize(dest))
}
func resized(_ image: CGImage, _ size: Int) -> CGImage {
 let ctx = context(size); ctx.interpolationQuality = .high
 ctx.draw(image, in: CGRect(x: 0, y: 0, width: size, height: size))
 return ctx.makeImage()!
}
let original = try load("eve-logo-source.png")
precondition(original.width == original.height)
let size = original.width
let ctx = context(size)
ctx.draw(original, in: CGRect(x: 0, y: 0, width: size, height: size))
let pixels = ctx.data!.assumingMemoryBound(to: UInt8.self)
var minX = size, minY = size, maxX = 0, maxY = 0
// Unmatte the white background using the darkest channel (the mark's red channel).
// Premultiplied output retains the source's antialiasing, texture and green hue.
for y in 0..<size { for x in 0..<size {
 let i = (y * size + x) * 4
 let sourceAlpha = Double(pixels[i+3]) / 255
 guard sourceAlpha > 0 else { continue }
 let rgb = (0..<3).map { min(255, Double(pixels[i + $0]) / sourceAlpha) }
 let matteAlpha = min(1, max(0, (255 - rgb.min()!) / 247))
 let alpha = matteAlpha * sourceAlpha
 for c in 0..<3 { pixels[i+c] = UInt8(max(0, min(255, ((rgb[c] - 255 * (1-matteAlpha)) * sourceAlpha).rounded()))) }
 pixels[i+3] = UInt8((alpha * 255).rounded())
 if alpha > 0.05 { minX = min(minX,x); maxX = max(maxX,x); minY = min(minY,y); maxY = max(maxY,y) }
} }
let padding = 24
let side = min(size, max(maxX-minX+1,maxY-minY+1) + 2*padding)
let cropX = max(0, min(size-side, (minX+maxX-side)/2))
let cropY = max(0, min(size-side, (minY+maxY-side)/2))
let logo = ctx.makeImage()!.cropping(to: CGRect(x: cropX, y: cropY, width: side, height: side))!
try fm.createDirectory(at: resources, withIntermediateDirectories: true)
save(resized(logo, 1024), resources.appendingPathComponent("eve-logo.png"))
save(resized(try load("eve-avatar-source.png"), 512), resources.appendingPathComponent("eve-avatar.png"))
let icon = context(1024)
icon.setFillColor(CGColor(srgbRed: 0.98, green: 0.96, blue: 0.92, alpha: 1))
icon.addPath(CGPath(roundedRect: CGRect(x: 100, y: 100, width: 824, height: 824), cornerWidth: 184, cornerHeight: 184, transform: nil))
icon.fillPath()
icon.interpolationQuality = .high
icon.draw(logo, in: CGRect(x: 206, y: 206, width: 612, height: 612))
let master = icon.makeImage()!
save(master, brand.appendingPathComponent("eve-icon-1024.png"))
let temp = fm.temporaryDirectory.appendingPathComponent("eve-brand-\(UUID().uuidString)")
let iconset = temp.appendingPathComponent("Eve.iconset")
try fm.createDirectory(at: iconset, withIntermediateDirectories: true)
defer { try? fm.removeItem(at: temp) }
for points in [16,32,128,256,512] {
 for scale in [1,2] {
  let suffix = scale == 2 ? "@2x" : ""
  save(resized(master, points*scale), iconset.appendingPathComponent("icon_\(points)x\(points)\(suffix).png"))
 }
}
let process = Process(); process.executableURL = URL(fileURLWithPath: "/usr/bin/iconutil")
process.arguments = ["-c", "icns", iconset.path, "-o", resources.appendingPathComponent("Eve.icns").path]
try process.run(); process.waitUntilExit(); precondition(process.terminationStatus == 0)
print("Generated transparent logo, unchanged avatar thumbnail, 1024 icon and full macOS ICNS.")

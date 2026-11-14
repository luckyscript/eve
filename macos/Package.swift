// swift-tools-version: 6.0
import PackageDescription
let package = Package(name: "Eve", platforms: [.macOS(.v14)], products: [.executable(name: "Eve", targets: ["Eve"])], targets: [.target(name: "EveProtocol"), .executableTarget(name: "Eve", dependencies: ["EveProtocol"]), .testTarget(name: "EveProtocolTests", dependencies: ["EveProtocol"])])

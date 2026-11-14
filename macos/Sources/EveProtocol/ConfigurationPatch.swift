import Foundation

public enum ConfigurationEditError: LocalizedError {
 case invalidNumber(String), redactedValue(String)
 public var errorDescription: String? {
  switch self {
  case .invalidNumber(let key): "\(key) 必须为有效数字。"
  case .redactedValue(let key): "\(key) 显示的是脱敏值。修改此字段需要输入完整新值；未编辑的字段会保留宿主原值。"
  }
 }
}
public enum ConfigurationPatch {
 public static func make(baseline: [String: String], draft: [String: String]) throws -> Data {
  var values: [String: Any] = [:]
  for (key, value) in draft where baseline[key] != value {
   if value.contains("[redacted]") { throw ConfigurationEditError.redactedValue(key) }
   if key == "skillsDirs" { values[key] = value.split(separator: "\n").map(String.init) }
   else if key == "userSkills" { values[key] = value == "true" || value == "1" }
   else if ["baseUrl", "model"].contains(key) { values[key] = value }
   else { guard let number = Double(value), number.isFinite else { throw ConfigurationEditError.invalidNumber(key) }; values[key] = number }
  }
  return try JSONSerialization.data(withJSONObject: values)
 }
}

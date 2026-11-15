import XCTest
import Foundation
@testable import EveProtocol

final class DraftPersistenceTests: XCTestCase, @unchecked Sendable {
 private func temporaryDirectory() throws -> URL {
  // Always inside this checkout; never consult Application Support or preferences.
  let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
  let directory = root.appendingPathComponent(".eve/draft-tests-" + UUID().uuidString)
  try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
  addTeardownBlock { try FileManager.default.removeItem(at: directory) }
  return directory
 }
 private func snapshot(_ prompt: String = "重启后恢复") -> DraftSnapshot {
  var drafts = ConversationDrafts()
  var draft = ConversationDraft(); draft.prompt = prompt; draft.contract = "../契约.json"; draft.autoEvolve = true
  drafts[ConversationKey(workspace: "/../../任意工作区", session: "s-1")] = draft
  return DraftSnapshot(drafts: drafts, workspaceDraftIDs: ["/../../任意工作区": "s-1"])
 }
 func testRoundTripPermissionsAndWorkspaceIsOnlyData() async throws {
  let directory = try temporaryDirectory().appendingPathComponent("private")
  let store = DraftPersistence(directory: directory)
  XCTAssertEqual(try store.load().drafts.keys.count, 0)
  store.schedule(snapshot())
  try await store.flush()
  let restored = try DraftPersistence(directory: directory).load()
  let key = ConversationKey(workspace: "/../../任意工作区", session: "s-1")
  XCTAssertEqual(restored.drafts[key]?.prompt, "重启后恢复")
  XCTAssertEqual(restored.drafts[key]?.contract, "../契约.json")
  XCTAssertEqual(restored.drafts[key]?.autoEvolve, true)
  XCTAssertEqual(restored.workspaceDraftIDs[key.workspace], key.session)
  for (url, mode) in [(directory, 0o700), (directory.appendingPathComponent("drafts.json"), 0o600)] {
   let attributes = try FileManager.default.attributesOfItem(atPath: url.path)
   XCTAssertEqual((attributes[.posixPermissions] as? NSNumber)?.intValue, mode)
  }
  XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: directory.path), ["drafts.json"])
 }
 func testFlushSavesNewestPendingSnapshotAndEmptyRemovesOldDraft() async throws {
  let directory = try temporaryDirectory()
  let store = DraftPersistence(directory: directory, debounce: 30)
  _ = try store.load()
  for number in 0..<50 { store.schedule(snapshot("版本\(number)")) }
  try await store.flush()
  XCTAssertEqual(try DraftPersistence(directory: directory).load().drafts.keys.count, 1)
  XCTAssertEqual(try DraftPersistence(directory: directory).load().drafts[ConversationKey(workspace: "/../../任意工作区", session: "s-1")]?.prompt, "版本49")
  var blanks = ConversationDrafts(); var blank = ConversationDraft(); blank.prompt = " \n\t"
  blanks[ConversationKey(workspace: "/empty", session: "empty")] = blank
  store.schedule(DraftSnapshot(drafts: blanks, workspaceDraftIDs: [:]))
  try await store.flush()
  XCTAssertTrue(try DraftPersistence(directory: directory).load().drafts.keys.isEmpty)
 }
 func testCorruptOrFutureFileIsPreservedAndBlocksSaving() async throws {
  for data in [Data("{broken".utf8), Data("{\"version\":999,\"entries\":[],\"workspaceDraftIDs\":{}}".utf8)] {
   let directory = try temporaryDirectory(); let file = directory.appendingPathComponent("drafts.json")
   try data.write(to: file)
   let store = DraftPersistence(directory: directory)
   XCTAssertThrowsError(try store.load())
   store.schedule(snapshot())
   do { try await store.flush(); XCTFail("must protect original") } catch {}
   XCTAssertEqual(try Data(contentsOf: file), data)
  }
 }
 func testExternalCorruptionAfterLoadIsPreservedAndRecoverableFromBackup() async throws {
  let directory = try temporaryDirectory(); let store = DraftPersistence(directory: directory)
  _ = try store.load(); store.schedule(snapshot()); try await store.flush()
  let file = directory.appendingPathComponent("drafts.json")
  let damaged = Data("{externally damaged".utf8)
  try damaged.write(to: file)
  store.schedule(snapshot("不能覆盖损坏文件"))
  do { try await store.flush(); XCTFail("must detect external modification") } catch {}
  XCTAssertEqual(try Data(contentsOf: file), damaged)
  let backup = directory.appendingPathComponent("drafts.recovery.json")
  try FileManager.default.moveItem(at: file, to: backup)
  let recovered = DraftPersistence(directory: directory)
  _ = try recovered.load(); recovered.schedule(snapshot("手动备份后可重新保存")); try await recovered.flush()
  XCTAssertEqual(try Data(contentsOf: backup), damaged)
  XCTAssertEqual(try recovered.load().drafts.keys.count, 1)
 }
 func testSymlinkSubstitutionAfterLoadIsRejected() async throws {
  let directory = try temporaryDirectory(); let store = DraftPersistence(directory: directory)
  _ = try store.load()
  let target = directory.appendingPathComponent("target"); try Data("untouched".utf8).write(to: target)
  try FileManager.default.createSymbolicLink(at: directory.appendingPathComponent("drafts.json"), withDestinationURL: target)
  store.schedule(snapshot())
  do { try await store.flush(); XCTFail("must reject substituted symlink") } catch {}
  XCTAssertEqual(try String(contentsOf: target, encoding: .utf8), "untouched")
 }
 func testOversizedDraftIsReportedWithoutReplacingLastGoodFile() async throws {
  let directory = try temporaryDirectory(); let store = DraftPersistence(directory: directory)
  _ = try store.load(); store.schedule(snapshot()); try await store.flush()
  let file = directory.appendingPathComponent("drafts.json"); let good = try Data(contentsOf: file)
  store.schedule(snapshot(String(repeating: "😀", count: DraftSnapshot.maxPromptUTF16)))
  do { try await store.flush(); XCTFail("must reject, never truncate") } catch {}
  XCTAssertEqual(try Data(contentsOf: file), good)
  store.schedule(snapshot("修复后可重试")); try await store.flush()
 }
 func testRejectsSymlinkFileAndDirectoryWithoutTouchingTarget() async throws {
  let root = try temporaryDirectory(); let target = root.appendingPathComponent("target")
  try Data("untouched".utf8).write(to: target)
  let directory = root.appendingPathComponent("store"); try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
  try FileManager.default.createSymbolicLink(at: directory.appendingPathComponent("drafts.json"), withDestinationURL: target)
  let store = DraftPersistence(directory: directory)
  XCTAssertThrowsError(try store.load()); store.schedule(snapshot())
  do { try await store.flush(); XCTFail("symlink must fail") } catch {}
  XCTAssertEqual(try String(contentsOf: target, encoding: .utf8), "untouched")
  let link = root.appendingPathComponent("link")
  try FileManager.default.createSymbolicLink(at: link, withDestinationURL: directory)
  XCTAssertThrowsError(try DraftPersistence(directory: link).load())
 }
 func testOversizedFileAndEntryCountAreRejected() throws {
  let directory = try temporaryDirectory(); let file = directory.appendingPathComponent("drafts.json")
  try Data(repeating: 32, count: DraftSnapshot.maxFileBytes + 1).write(to: file)
  XCTAssertThrowsError(try DraftPersistence(directory: directory).load())
  var drafts = ConversationDrafts(); var draft = ConversationDraft(); draft.prompt = "keep"
  for i in 0...DraftSnapshot.maxDrafts { drafts[ConversationKey(workspace: "/w", session: "s\(i)")] = draft }
  XCTAssertThrowsError(try DraftSnapshot(drafts: drafts, workspaceDraftIDs: [:]).validated())
 }
 func testEmptyDraftsAndOrphanWorkspaceIDsDoNotAccumulate() throws {
  var drafts = ConversationDrafts(); var blank = ConversationDraft(); blank.prompt = " \n\t"
  var ids: [String: String] = [:]
  for i in 0..<1000 {
   let key = ConversationKey(workspace: "/empty\(i)", session: "s\(i)")
   drafts[key] = blank; ids[key.workspace] = key.session
  }
  XCTAssertTrue(drafts.keys.isEmpty)
  let clean = try DraftSnapshot(drafts: drafts, workspaceDraftIDs: ids).validated()
  XCTAssertTrue(clean.entries.isEmpty); XCTAssertTrue(clean.workspaceDraftIDs.isEmpty)
 }
 func testDebouncedSaveRunsWithoutFlushAndOldTimersCannotOverwriteFlush() async throws {
  let directory = try temporaryDirectory(); let store = DraftPersistence(directory: directory, debounce: 0.03)
  _ = try store.load(); store.schedule(snapshot("自动保存"))
  try await Task.sleep(for: .milliseconds(200))
  let key = ConversationKey(workspace: "/../../任意工作区", session: "s-1")
  XCTAssertEqual(try DraftPersistence(directory: directory).load().drafts[key]?.prompt, "自动保存")
  store.schedule(snapshot("旧定时器")); store.schedule(snapshot("退出时最新状态"))
  try await store.flush()
  try await Task.sleep(for: .milliseconds(100))
  XCTAssertEqual(try DraftPersistence(directory: directory).load().drafts[key]?.prompt, "退出时最新状态")
 }
 func testBackgroundFailureReportsSafeDiagnosticAndRetainsPending() async throws {
  let directory = try temporaryDirectory(); let store = DraftPersistence(directory: directory, debounce: 0)
  _ = try store.load()
  let reported = expectation(description: "background failure")
  reported.assertForOverFulfill = false // Retrying flush may report the same retained failure again.
  let secretMarker = "DO-NOT-ECHO-DRAFT"
  store.schedule(snapshot(secretMarker + String(repeating: "a", count: DraftSnapshot.maxPromptUTF16))) { message in
   XCTAssertFalse(message.contains(secretMarker)); XCTAssertTrue(message.contains("未截断")); reported.fulfill()
  }
  await fulfillment(of: [reported], timeout: 2)
  do { try await store.flush(); XCTFail("failed snapshot must remain pending") } catch {}
  XCTAssertFalse(FileManager.default.fileExists(atPath: directory.appendingPathComponent("drafts.json").path))
 }
 func testDuplicateKeysAndWorkspaceCountAndMetadataAreBounded() throws {
  let original = snapshot()
  var duplicate = original; duplicate.entries += original.entries
  XCTAssertThrowsError(try duplicate.validated())
  var tooManyWorkspaces = original
  tooManyWorkspaces.workspaceDraftIDs = Dictionary(uniqueKeysWithValues: (0...DraftSnapshot.maxWorkspaces).map { ("w\($0)", "s") })
  XCTAssertThrowsError(try tooManyWorkspaces.validated())
  var metadata = ConversationDrafts(); var draft = ConversationDraft(); draft.prompt = "keep"; draft.contractState = String(repeating: "a", count: 4097)
  metadata[ConversationKey(workspace: "/w", session: "s")] = draft
  XCTAssertThrowsError(try DraftSnapshot(drafts: metadata).validated())
 }
 func testBundleIdentifiersAreIsolatedAndRequired() throws {
  let base = try temporaryDirectory()
  let production = try DraftPersistence.defaultDirectory(bundleIdentifier: "com.eve.app", applicationSupport: base)
  let evaluation = try DraftPersistence.defaultDirectory(bundleIdentifier: "com.eve.ui-eval", applicationSupport: base)
  XCTAssertNotEqual(production, evaluation)
  XCTAssertTrue(production.path.hasPrefix(base.path + "/"))
  XCTAssertThrowsError(try DraftPersistence.defaultDirectory(bundleIdentifier: nil, applicationSupport: base))
  XCTAssertThrowsError(try DraftPersistence.defaultDirectory(bundleIdentifier: "../escape", applicationSupport: base))
 }
}

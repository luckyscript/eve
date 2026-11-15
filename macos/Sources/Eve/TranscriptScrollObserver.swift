import SwiftUI
import AppKit

/// Tracks user scroll gestures separately from document growth. Appending text
/// must not turn following off before the view has a chance to scroll to it.
struct TranscriptScrollObserver: NSViewRepresentable {
 var onUserScroll: (Bool) -> Void
 func makeNSView(context: Context) -> Probe { Probe(onUserScroll: onUserScroll) }
 func updateNSView(_ view: Probe, context: Context) { view.onUserScroll = onUserScroll; view.observeScrollView() }
 static func dismantleNSView(_ view: Probe, coordinator: ()) { view.removeObserver() }
 @MainActor final class Probe: NSView {
  var onUserScroll: (Bool) -> Void
  private var observer: NSObjectProtocol?
  private weak var observed: NSScrollView?
  init(onUserScroll: @escaping (Bool) -> Void) { self.onUserScroll = onUserScroll; super.init(frame: .zero) }
  required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }
  override func viewDidMoveToWindow() { super.viewDidMoveToWindow(); observeScrollView() }
  func observeScrollView() {
   guard let scroll = enclosingScrollView, observed !== scroll else { return }
   removeObserver(); observed = scroll
   observer = NotificationCenter.default.addObserver(forName: NSScrollView.didLiveScrollNotification, object: scroll, queue: .main) { [weak self, weak scroll] _ in
    MainActor.assumeIsolated {
     guard let scroll, let document = scroll.documentView else { return }
     self?.onUserScroll(scroll.documentVisibleRect.maxY >= document.bounds.maxY - 45)
    }
   }
  }
  func removeObserver() { if let observer { NotificationCenter.default.removeObserver(observer) }; observer = nil; observed = nil }
 }
}

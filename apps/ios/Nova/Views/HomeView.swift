import SwiftUI

/// Nova, connected: the Orb, what it heard and said, its cards, and the talk button.
struct HomeView: View {
  @Environment(Nova.self) private var nova
  @State private var showMac = false
  @State private var typing = false
  @State private var draft = ""
  @FocusState private var typingFocus: Bool

  var body: some View {
    VStack(spacing: 14) {
      top
      pill
      if let computer = nova.computer {
        Label(computer, systemImage: "cursorarrow.motionlines")
          .font(.footnote.weight(.semibold))
          .padding(.horizontal, 14).padding(.vertical, 8)
          .glass(radius: 16)
      }
      ZStack {
        Circle()
          .fill(RadialGradient(colors: [Color(red: 0.42, green: 0.39, blue: 1).opacity(0.45), .clear], center: .center, startRadius: 10, endRadius: 160))
          .scaleEffect(1 + CGFloat(nova.level) * 0.25)
          .animation(.easeOut(duration: 0.15), value: nova.level)
        OrbView(phase: nova.phase, level: nova.level)
      }
      .frame(width: 280, height: 280)
      captions
      CardsView()
      Spacer(minLength: 0)
      if typing { typingBar } else { controls }
    }
    .padding(.horizontal, 18)
    .padding(.bottom, 10)
    .background { Backdrop() }
    .sheet(isPresented: Bindable(nova).showingTasks) { TasksView().presentationDetents([.medium, .large]) }
    .overlay(alignment: .top) { NoticeView() }
  }

  private var top: some View {
    HStack(spacing: 10) {
      Circle().fill(nova.link == .connected ? Style.ok : Style.warn).frame(width: 8, height: 8)
      VStack(alignment: .leading, spacing: 1) {
        Text(nova.name).font(.headline)
        Text(linkText).font(.caption).foregroundStyle(Style.dim).lineLimit(1)
      }
      Spacer()
      Button { nova.showingTasks = true } label: {
        Image(systemName: "asterisk")
          .font(.headline)
          .frame(width: 40, height: 40)
          .glass(radius: 14)
          .overlay(alignment: .topTrailing) {
            if nova.tasks.contains(where: { $0.status == "running" }) { Circle().fill(Style.accent).frame(width: 9, height: 9).offset(x: 2, y: -2) }
          }
      }
      .accessibilityLabel("Agent tasks")
      Button { showMac = true } label: {
        Image(systemName: "laptopcomputer").font(.headline).frame(width: 40, height: 40).glass(radius: 14)
      }
      .accessibilityLabel("This iPhone and your Mac")
      // Its own sheet, here: two on one view, and SwiftUI shows only one of them.
      .sheet(isPresented: $showMac) { MacView().presentationDetents([.medium, .large]) }
    }
    .foregroundStyle(.white)
    .padding(.top, 6)
  }

  private var linkText: String {
    switch nova.link {
    case .connected: return nova.mac.map { "on \($0.name.replacingOccurrences(of: "\(nova.name) on ", with: ""))" } ?? "connected"
    case .connecting: return "Connecting to your Mac…"
    case .offline(let why): return why
    case .lost(let why): return why
    case .unpaired: return "Not paired"
    }
  }

  private var pill: some View {
    HStack(spacing: 8) {
      Circle().fill(nova.talking ? Color.cyan : ["idle", "listening"].contains(nova.phase) ? Style.faint : Style.accent).frame(width: 8, height: 8)
      // Listening is what this iPhone's microphone is doing: the Mac's own listening window needs the button here.
      Text(nova.talking ? (nova.hearingHere ? "Listening · on this iPhone" : "Listening") : phaseText(nova.phase == "listening" ? "idle" : nova.phase, label: nova.phaseLabel))
        .font(.subheadline.weight(.semibold))
    }
    .padding(.horizontal, 16).padding(.vertical, 9)
    .glass(radius: 20)
  }

  private var captions: some View {
    VStack(spacing: 8) {
      if !nova.heard.isEmpty {
        Text("“\(nova.heard)”").font(.callout).foregroundStyle(Style.dim).multilineTextAlignment(.center).lineLimit(3)
      }
      if !nova.reply.isEmpty {
        Text(nova.reply).font(.title3.weight(.semibold)).multilineTextAlignment(.center).lineLimit(6)
          .transition(.opacity.combined(with: .move(edge: .bottom)))
      } else if nova.heard.isEmpty {
        Text(nova.link == .connected ? "Hold the button and talk - or tap it and just talk." : "Waiting for your Mac…").font(.callout).foregroundStyle(Style.faint)
      }
    }
    .foregroundStyle(.white)
    .animation(.easeOut(duration: 0.25), value: nova.reply)
    .frame(maxWidth: .infinity)
  }

  private var controls: some View {
    HStack(spacing: 22) {
      Button {
        typing = true
        typingFocus = true
      } label: {
        Image(systemName: "keyboard").font(.title3).frame(width: 56, height: 56).glass(radius: 28)
      }
      .accessibilityLabel("Type to \(nova.name)")
      TalkButton()
      Button { nova.stop() } label: {
        Image(systemName: "stop.fill").font(.title3).frame(width: 56, height: 56).glass(radius: 28)
      }
      .accessibilityLabel("Stop everything")
    }
    .foregroundStyle(.white)
    .disabled(nova.link != .connected)
    .opacity(nova.link == .connected ? 1 : 0.5)
  }

  private var typingBar: some View {
    HStack(spacing: 10) {
      TextField("Ask \(nova.name)…", text: $draft)
        .focused($typingFocus)
        .submitLabel(.send)
        .onSubmit(send)
        .padding(.horizontal, 16).padding(.vertical, 14)
        .glass(radius: 22)
      Button(action: send) {
        Image(systemName: "arrow.up").font(.headline).frame(width: 48, height: 48).background(Style.accent, in: Circle())
      }
      Button {
        typing = false
        draft = ""
      } label: {
        Image(systemName: "xmark").font(.headline).frame(width: 48, height: 48).glass(radius: 24)
      }
    }
    .foregroundStyle(.white)
  }

  private func send() {
    nova.type(draft)
    draft = ""
    typing = false
  }
}

/// Hold to talk and let go when you're done - or tap it and just talk: the turn ends when you pause, or tap it
/// again (as the Mac's ⌥Space).
struct TalkButton: View {
  @Environment(Nova.self) private var nova
  @State private var pressedAt: Date?

  var body: some View {
    let on = nova.talking
    Circle()
      .fill(on ? AnyShapeStyle(LinearGradient(colors: [.cyan, Style.accent], startPoint: .top, endPoint: .bottom)) : AnyShapeStyle(.ultraThinMaterial))
      .overlay(Circle().stroke(Color.white.opacity(on ? 0.5 : 0.18), lineWidth: 1.5))
      .overlay(Image(systemName: on ? "waveform" : "mic.fill").font(.system(size: 30, weight: .semibold)).symbolEffect(.variableColor.iterative, isActive: on))
      .frame(width: 88, height: 88)
      .scaleEffect(on ? 1.08 : 1)
      .animation(.spring(response: 0.25, dampingFraction: 0.6), value: on)
      .gesture(
        DragGesture(minimumDistance: 0)
          .onChanged { _ in
            guard pressedAt == nil else { return }
            pressedAt = Date()
            UIImpactFeedbackGenerator(style: .medium).impactOccurred()
            // Tapped again while a tapped turn listens: that's the end of it.
            if nova.talking, nova.tapped {
              Task { await nova.talkEnd() }
            } else {
              Task { await nova.talkStart() }
            }
          }
          .onEnded { _ in
            defer { pressedAt = nil }
            guard let pressedAt, nova.talking, !nova.tapped else { return }
            // A quick tap: talk, and the turn ends when you pause. A hold ends when it's let go.
            if Date().timeIntervalSince(pressedAt) < 0.35 {
              nova.talkTapped()
            } else {
              Task { await nova.talkEnd() }
            }
          }
      )
      .accessibilityLabel(on ? "Listening - let go when you're done" : "Hold to talk")
      .accessibilityAddTraits(.isButton)
  }
}

/// A short message at the top: what went wrong, or what happened.
struct NoticeView: View {
  @Environment(Nova.self) private var nova

  var body: some View {
    if let notice = nova.notice {
      Text(notice)
        .font(.footnote.weight(.medium))
        .foregroundStyle(.white)
        .multilineTextAlignment(.center)
        .padding(.horizontal, 16).padding(.vertical, 10)
        .glass(radius: 16)
        .padding(.horizontal, 24)
        .padding(.top, 8)
        .onTapGesture { nova.notice = nil }
        .task(id: notice) {
          try? await Task.sleep(for: .seconds(6))
          if nova.notice == notice { nova.notice = nil }
        }
        .transition(.move(edge: .top).combined(with: .opacity))
    }
  }
}

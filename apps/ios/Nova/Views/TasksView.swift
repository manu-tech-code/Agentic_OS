import SwiftUI

/// The agents' task board, as the Mac's (⌘U): what each is doing now, what it said when it finished, why it
/// failed - with Stop, and Run again.
struct TasksView: View {
  @Environment(Nova.self) private var nova

  var body: some View {
    NavigationStack {
      List {
        if nova.tasks.isEmpty {
          Text("No tasks yet. Say “ask Claude to …” and it shows here.").foregroundStyle(.secondary)
        }
        ForEach(nova.tasks) { task in
          VStack(alignment: .leading, spacing: 6) {
            HStack {
              Circle().fill(color(task.status)).frame(width: 8, height: 8)
              Text(task.label).font(.headline)
              if !task.project.isEmpty { Text(task.project).foregroundStyle(.secondary) }
              Spacer()
              Text(status(task)).font(.caption).foregroundStyle(.secondary)
            }
            Text(task.task).font(.subheadline)
            if let step = task.status == "running" ? task.step : task.report {
              Text(step).font(.footnote.monospaced()).foregroundStyle(.secondary).lineLimit(6)
            }
            HStack {
              if task.status == "running" {
                Button("Stop", role: .destructive) { nova.cancelTask(task.id) }
              } else if task.status == "failed" || task.status == "cancelled" {
                Button("Run again") { nova.retryTask(task.id) }
              }
            }
            .buttonStyle(.bordered)
            .font(.footnote)
          }
          .padding(.vertical, 4)
        }
      }
      .navigationTitle("Agent tasks")
      .navigationBarTitleDisplayMode(.inline)
    }
  }

  private func color(_ status: String) -> Color {
    switch status {
    case "running": return Style.warn
    case "done": return Style.ok
    case "failed": return .red
    default: return .gray
    }
  }

  private func status(_ task: AgentTask) -> String {
    let when = (task.ended ?? task.started).formatted(date: .omitted, time: .shortened)
    switch task.status {
    case "running": return "working · since \(task.started.formatted(date: .omitted, time: .shortened))"
    case "done": return "done · \(when)"
    case "failed": return "failed · \(when)"
    default: return "stopped · \(when)"
    }
  }
}

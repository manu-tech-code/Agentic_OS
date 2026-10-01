import FoundationModels

/// Whether this Mac can answer with Apple's on-device model, and what the model is.
enum Status {
  static func now() -> [String: Any] {
    let model = SystemLanguageModel.default
    var status: [String: Any] = ["type": "status", "contextSize": model.contextSize, "language": model.supportsLocale()]
    switch model.availability {
    case .available:
      status["available"] = true
    case .unavailable(let reason):
      status["available"] = false
      status["reason"] = code(reason)
    }
    if #available(macOS 27, *) {
      status["model"] = model.variant.displayName
      status["vision"] = model.capabilities.contains(.vision)
    }
    return status
  }

  /// Why the model can't answer, as a code the daemon puts into words.
  static func code(_ reason: SystemLanguageModel.Availability.UnavailableReason) -> String {
    switch reason {
    case .deviceNotEligible: "device"
    case .appleIntelligenceNotEnabled: "off"
    case .modelNotReady: "downloading"
    @unknown default: "unknown"
    }
  }
}

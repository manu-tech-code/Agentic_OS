import FoundationModels

/// A tool's JSON schema - how Nova's tools and the user's services describe their arguments - as
/// the framework's own: objects, arrays, strings (and choices of them), numbers and booleans.
/// What it can't express (unions, references) becomes free text, for the tool to read as it can.
func generationSchema(_ json: [String: Any], name: String) throws -> GenerationSchema {
  try GenerationSchema(root: dynamicSchema(json, name: name), dependencies: [])
}

/// Each object is named after its place in the schema ("open_app_arguments_filter"), so no two share a name.
func dynamicSchema(_ json: [String: Any], name: String) -> DynamicGenerationSchema {
  let description = json["description"] as? String
  if let choices = (json["enum"] as? [Any])?.compactMap({ $0 as? String }), !choices.isEmpty {
    return DynamicGenerationSchema(name: name, description: description, anyOf: choices)
  }
  // ["string", "null"]: the value may be left out, which an optional property already says.
  let type = json["type"] as? String ?? (json["type"] as? [String])?.first { $0 != "null" }
  switch type {
  case "object":
    let properties = json["properties"] as? [String: Any] ?? [:]
    let required = Set(json["required"] as? [String] ?? [])
    return DynamicGenerationSchema(name: name, description: description, properties: properties.keys.sorted().map { key in
      let property = properties[key] as? [String: Any] ?? [:]
      return .init(name: key, description: property["description"] as? String, schema: dynamicSchema(property, name: "\(name)_\(key)"), isOptional: !required.contains(key))
    })
  case "array":
    let items = json["items"] as? [String: Any] ?? [:]
    return DynamicGenerationSchema(arrayOf: dynamicSchema(items, name: "\(name)_item"), minimumElements: json["minItems"] as? Int, maximumElements: json["maxItems"] as? Int)
  case "integer":
    return DynamicGenerationSchema(type: Int.self)
  case "number":
    return DynamicGenerationSchema(type: Double.self)
  case "boolean":
    return DynamicGenerationSchema(type: Bool.self)
  default:
    return DynamicGenerationSchema(type: String.self)
  }
}

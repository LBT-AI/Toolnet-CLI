export function getModelTags(modelId: string): string {
  const tags: string[] = [];
  const lower = modelId.toLowerCase();
  
  // Vision
  if (lower.includes("vision") || lower.includes("claude") || lower.includes("gpt-4o") || lower.includes("gemini")) {
    tags.push("[Vision]");
  }
  
  // Reasoning
  if (lower.includes("r1") || lower.includes("reasoning") || lower.includes("o1") || lower.includes("o3") || lower.includes("think") || lower.includes("deepseek")) {
    tags.push("[Reasoning]");
  }
  
  // Context
  if (lower.includes("gemini-1.5") || lower.includes("gemini-2.0") || lower.includes("gemini-exp") || lower.includes("pro-1")) {
    tags.push("[Context: 1M+]");
  } else if (lower.includes("claude-3") || lower.includes("gpt-4") || lower.includes("r1") || lower.includes("sonnet") || lower.includes("deepseek")) {
    tags.push("[Context: 128k]");
  } else {
    tags.push("[Context: 8k+]");
  }
  
  return tags.length > 0 ? " " + tags.join(" ") : "";
}

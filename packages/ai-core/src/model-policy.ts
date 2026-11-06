// Public endpoint metadata checked 2026-10-27; not a paid inference quality test.
export const modelProfile = {
  version: "qwen-pilot-v1",
  model: "qwen/qwen3.5-9b",
  // Exact canonical_slug for this alias in OpenRouter's public catalog, checked 2026-11-06.
  canonicalModel: "qwen/qwen3.5-9b-20260310",
  provider: "deepinfra/bf16",
  promptVersion: "communication-prompts-v1",
  maxAssessmentCorrections: 1,
} as const;

export const providerPolicy = {
  only: [modelProfile.provider],
  allow_fallbacks: false,
  require_parameters: true,
  data_collection: "deny",
  zdr: true,
} as const;

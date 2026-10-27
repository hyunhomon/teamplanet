// Public endpoint metadata checked 2026-10-27; not a paid inference quality test.
export const modelProfile = {
  version: "qwen-pilot-v1",
  model: "qwen/qwen3.5-9b",
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

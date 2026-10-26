import { competencyKeys } from "./keys";
export { competencyKeys } from "./keys";

export type CompetencyKey = (typeof competencyKeys)[number];
export type Judgement = "observed_strength" | "mixed" | "needs_support" | "insufficient_evidence";
export type AnalysisStatus =
  | "queued" | "collecting" | "evidence_extraction" | "assessment" | "review"
  | "awaiting_professor" | "finalized" | "blocked_provider_billing"
  | "failed_provider_auth" | "rate_limited" | "failed_model" | "failed_data" | "cancelled";

export interface EvidenceEvent {
  id: string;
  teamId: string;
  channelId: string;
  messageIds: string[];
  actorIds: string[];
  contextualSummary: string;
  behaviorTags: CompetencyKey[];
  sourceModality: "text" | "image" | "mixed";
}

export interface CompetencyAssessment {
  studentId: string;
  key: CompetencyKey;
  judgement: Judgement;
  narrative: string;
  evidenceIds: string[];
  counterEvidenceIds: string[];
  confidence: "low" | "medium" | "high";
  limitations: string[];
  requiresHumanReview: boolean;
}

export interface AnalysisRunRequest { teamId: string; from: string; to: string }

export interface ProviderBillingError {
  code: "OPENROUTER_BILLING_BLOCKED";
  providerStatus: 402;
  kind: "insufficient_credits" | "key_limit_exhausted" | "in_flight_budget" | "unspecified_provider_billing";
  source?: string;
  retryable: boolean;
  retryAfterSeconds?: number;
}

export * from "./api";
export * from "./validation";

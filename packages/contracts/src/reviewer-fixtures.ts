import { reviewInputFixture, correctionRequestFixture } from "./analysis-fixtures";
// Synthetic semantic errors with structurally valid references. These are mock model expectations, not a quality benchmark.
export const reviewerFaultFixtures = [
  { name: "fabricated_quotation", narrative: "학생이 ‘수업 전체 오류를 완전히 해결했다’고 명시했다.", code: "unsupported_claim", instruction: "실제 발화가 설명하는 재현 조건만 남기세요." },
  { name: "wrong_student_attribution", narrative: "동료의 해결 작업도 이 학생이 모두 수행했다.", code: "unsupported_claim", instruction: "해당 학생에게 확인되는 행동으로 귀속을 제한하세요." },
  { name: "suppressed_counterexample", narrative: "언제나 의견을 받아들였고 반대 사례는 없다.", code: "counterevidence_missing", instruction: "앞선 설명의 모호함과 후속 정정을 함께 검토하세요." },
  { name: "activity_volume_bias", narrative: "메시지가 많아서 의사소통 역량이 높다.", code: "activity_bias", instruction: "발화 빈도 대신 관찰된 설명의 유용성만 판단하세요." },
  { name: "overgeneralization", narrative: "이 학생은 모든 상황에서 완벽하게 소통한다.", code: "overgeneralization", instruction: "단일 기간의 관찰 가능한 행동으로 단정을 제한하세요." },
] as const;
export function reviewerFaultFixture(index: number) {
  const fault = reviewerFaultFixtures[index]!;
  return structuredClone({ input: { ...reviewInputFixture, assessment: { ...reviewInputFixture.assessment,
    assessments: [{ ...reviewInputFixture.assessment.assessments[0]!, narrative: fault.narrative }] } },
    output: { ...correctionRequestFixture, issues: [{ ...correctionRequestFixture.issues[0]!, id: `issue_${fault.name}`, code: fault.code, instruction: fault.instruction }] } });
}

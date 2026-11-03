import { expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ProfessorInquiries from "../apps/web/src/components/ProfessorInquiries";
import StudentInquiries from "../apps/web/src/components/StudentInquiries";
import { courses } from "@teamplanet/contracts/fixtures";
test("professor inquiry UI offers explicit n with no default; student surface has no assessment or attachment controls", () => {
  const professor = renderToStaticMarkup(createElement(ProfessorInquiries, { courseId: courses[0]!.id }));
  expect(professor).toContain('type="number"'); expect(professor).toContain('value=""');
  expect(professor).toContain("문의 기한 저장"); expect(professor).toContain("기본 기한은 없습니다");
  const student = renderToStaticMarkup(createElement(StudentInquiries));
  expect(student).toContain("본인 웹 문의"); expect(student).toContain("개인 링크를 공유하지 마세요");
  expect(student).not.toContain('type="file"'); expect(student).toContain("최신 상태 조회");
});

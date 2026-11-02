import { Hono } from "hono";
import { courseParamsSchema, createCourseSchema, createStudentSchema, rubricSelectionSchema, courseRubricResponseSchema, type Course, type Student } from "@teamplanet/contracts";
import { apiError, parseBody } from "./errors";
import { audit, owned, type ProtectedEnv } from "./guard";

type StudentRow = { id: string; course_id: string; display_name: string; created_at: number };
const toStudent = (row: StudentRow): Student => ({
  id: row.id, courseId: row.course_id, displayName: row.display_name, createdAt: new Date(row.created_at).toISOString(),
});

type CourseRow = { id: string; professor_id: string; name: string; created_at: number };
const toCourse = (row: CourseRow): Course => ({
  id: row.id, professorId: row.professor_id, name: row.name, createdAt: new Date(row.created_at).toISOString(),
});

export function courseRoutes(now: () => number) {
  const routes = new Hono<ProtectedEnv>();

  routes.get("/courses/:courseId/rubric", async context => {
    const path = courseParamsSchema.safeParse({ courseId: context.req.param("courseId") });
    if (!path.success) return apiError(context, "VALIDATION_ERROR", "요청 형식을 확인하세요.");
    const { courseId } = path.data;
    if (!await owned(context, "course", courseId)) {
      await audit(context, { action: "course.rubric_read", targetType: "course", targetId: courseId, result: "denied" }, now).run();
      return apiError(context, "NOT_FOUND", "리소스를 찾을 수 없습니다.");
    }
    const row = await context.env.DB.prepare("SELECT rubric_version, selected_competencies_json, updated_at FROM course_rubric_settings WHERE course_id = ?")
      .bind(courseId).first<{ rubric_version: string; selected_competencies_json: string; updated_at: number }>();
    return context.json(courseRubricResponseSchema.parse({ courseId,
      selection: row ? { rubricVersion: row.rubric_version, selectedCompetencies: JSON.parse(row.selected_competencies_json) } : null,
      updatedAt: row ? new Date(row.updated_at).toISOString() : null,
    }), 200);
  });

  routes.put("/courses/:courseId/rubric", async context => {
    const path = courseParamsSchema.safeParse({ courseId: context.req.param("courseId") });
    if (!path.success) return apiError(context, "VALIDATION_ERROR", "요청 형식을 확인하세요.");
    const { courseId } = path.data;
    if (!await owned(context, "course", courseId)) {
      await audit(context, { action: "course.rubric_set", targetType: "course", targetId: courseId, result: "denied" }, now).run();
      return apiError(context, "NOT_FOUND", "리소스를 찾을 수 없습니다.");
    }
    const input = await parseBody(context, rubricSelectionSchema);
    if (input.error) return input.error;
    const at = now();
    await context.env.DB.batch([
      context.env.DB.prepare(`INSERT INTO course_rubric_settings (course_id, rubric_version, selected_competencies_json, updated_at)
        VALUES (?, ?, ?, ?) ON CONFLICT(course_id) DO UPDATE SET rubric_version = excluded.rubric_version,
        selected_competencies_json = excluded.selected_competencies_json, updated_at = excluded.updated_at`)
        .bind(courseId, input.data.rubricVersion, JSON.stringify(input.data.selectedCompetencies), at),
      audit(context, { action: "course.rubric_set", targetType: "course", targetId: courseId, result: "succeeded" }, () => at),
    ]);
    return context.json(courseRubricResponseSchema.parse({ courseId, selection: input.data, updatedAt: new Date(at).toISOString() }), 200);
  });

  routes.post("/courses", async context => {
    const input = await parseBody(context, createCourseSchema);
    if (input.error) return input.error;
    const row: CourseRow = {
      id: `course_${crypto.randomUUID()}`, professor_id: context.get("professor").id, name: input.data.name, created_at: now(),
    };
    await context.env.DB.batch([
      context.env.DB.prepare("INSERT INTO courses (id, professor_id, name, created_at) VALUES (?, ?, ?, ?)")
        .bind(row.id, row.professor_id, row.name, row.created_at),
      audit(context, { action: "course.create", targetType: "course", targetId: row.id, result: "succeeded" }, now),
    ]);
    return context.json(toCourse(row), 201);
  });

  routes.get("/courses", async context => {
    const { results } = await context.env.DB.prepare("SELECT * FROM courses WHERE professor_id = ? ORDER BY created_at, id")
      .bind(context.get("professor").id).all<CourseRow>();
    return context.json({ courses: results.map(toCourse) }, 200);
  });

  // #7: students belong to one owned course; their Slack account is linked later through team membership.
  routes.post("/courses/:courseId/students", async context => {
    const path = courseParamsSchema.safeParse({ courseId: context.req.param("courseId") });
    if (!path.success) return apiError(context, "VALIDATION_ERROR", "요청 형식을 확인하세요.");
    const input = await parseBody(context, createStudentSchema);
    if (input.error) return input.error;
    if (!await owned(context, "course", path.data.courseId)) return apiError(context, "NOT_FOUND", "리소스를 찾을 수 없습니다.");
    const row: StudentRow = { id: `student_${crypto.randomUUID()}`, course_id: path.data.courseId, display_name: input.data.displayName, created_at: now() };
    await context.env.DB.batch([
      context.env.DB.prepare("INSERT INTO students (id, course_id, display_name, created_at) VALUES (?, ?, ?, ?)")
        .bind(row.id, row.course_id, row.display_name, row.created_at),
      audit(context, { action: "student.create", targetType: "student", targetId: row.id, result: "succeeded" }, now),
    ]);
    return context.json(toStudent(row), 201);
  });

  routes.get("/courses/:courseId/students", async context => {
    const path = courseParamsSchema.safeParse({ courseId: context.req.param("courseId") });
    if (!path.success) return apiError(context, "VALIDATION_ERROR", "요청 형식을 확인하세요.");
    if (!await owned(context, "course", path.data.courseId)) return apiError(context, "NOT_FOUND", "리소스를 찾을 수 없습니다.");
    const { results } = await context.env.DB.prepare("SELECT * FROM students WHERE course_id = ? ORDER BY created_at, id")
      .bind(path.data.courseId).all<StudentRow>();
    return context.json({ students: results.map(toStudent) }, 200);
  });

  return routes;
}

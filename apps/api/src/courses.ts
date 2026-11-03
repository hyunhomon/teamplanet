import { Hono } from "hono";
import { createCourseSchema, type Course } from "@teamplanet/contracts";
import { parseBody } from "./errors";
import { audit, type ProtectedEnv } from "./guard";

type CourseRow = { id: string; professor_id: string; name: string; created_at: number };
const toCourse = (row: CourseRow): Course => ({
  id: row.id, professorId: row.professor_id, name: row.name, createdAt: new Date(row.created_at).toISOString(),
});

export function courseRoutes(now: () => number) {
  const routes = new Hono<ProtectedEnv>();

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

  return routes;
}

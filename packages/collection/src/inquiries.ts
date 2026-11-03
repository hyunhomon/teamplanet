import type { D1Database } from "@cloudflare/workers-types";
import { retentionDeadlineSql } from "./lifecycle";
/** Each successful batch removes every expired body/answer and its submission capability, never consent state. */
export async function sweepInquiries(db: D1Database, now: number) {
  try {
    await db.batch([
      db.prepare("DELETE FROM inquiry_tickets WHERE valid_until <= ? OR inquiry_id IN (SELECT id FROM inquiries WHERE expires_at <= ?)").bind(now, now),
      db.prepare("DELETE FROM inquiries WHERE expires_at <= ?").bind(now),
      db.prepare(`DELETE FROM inquiry_effects WHERE team_id IN (SELECT t.id FROM teams t JOIN courses c ON c.id = t.course_id WHERE ${retentionDeadlineSql("c")} <= ?)`).bind(now),
      db.prepare("UPDATE inquiry_settings SET last_cleanup_at = ?, cleanup_error = NULL").bind(now),
    ]);
  } catch {
    await db.prepare("UPDATE inquiry_settings SET cleanup_error = 'INQUIRY_CLEANUP_FAILED'").run();
    throw new Error("INQUIRY_CLEANUP_FAILED");
  }
}

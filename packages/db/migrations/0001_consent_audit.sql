-- Preserve any current snapshots before enabling automatic audit capture.
INSERT INTO consent_history (team_id, student_id, status, version, recorded_at)
SELECT team_id, student_id, status, version, recorded_at FROM consents;
--> statement-breakpoint
CREATE TRIGGER consents_audit_insert
AFTER INSERT ON consents
BEGIN
  INSERT INTO consent_history (team_id, student_id, status, version, recorded_at)
  VALUES (NEW.team_id, NEW.student_id, NEW.status, NEW.version, NEW.recorded_at);
END;
--> statement-breakpoint
CREATE TRIGGER consents_audit_update
AFTER UPDATE ON consents
BEGIN
  INSERT INTO consent_history (team_id, student_id, status, version, recorded_at)
  VALUES (NEW.team_id, NEW.student_id, NEW.status, NEW.version, NEW.recorded_at);
END;

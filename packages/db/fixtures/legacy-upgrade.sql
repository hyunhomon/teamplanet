-- Entirely synthetic pre-contract data. No real identities or conversations.
INSERT INTO workspaces VALUES ('legacy-workspace', 'TLEGACY01', 1000);
INSERT INTO teams VALUES ('legacy-team', 'legacy-workspace', 'CLEGACY01', 'Legacy team', 'inactive');
INSERT INTO consents VALUES ('legacy-team', 'legacy-student', 'granted', 'v1', 1000);
INSERT INTO analysis_runs VALUES ('legacy-run', 'legacy-team', '1', '2', 'awaiting_professor', '{"stage":"review"}', 'legacy-professor');
INSERT INTO evidence_events VALUES ('legacy-evidence', 'legacy-run', '["legacy-message"]', '["legacy-student"]', 'Synthetic evidence', '["clarity"]');
INSERT INTO messages VALUES ('legacy-message', 'legacy-team', 'CLEGACY01', '1.000001', 'ULEGACY01', NULL, 'Invented text', '[]', NULL);
INSERT INTO assessments VALUES ('legacy-assessment', 'legacy-run', 'legacy-student', 'clarity', 'mixed', 'Synthetic narrative', '["legacy-evidence"]', '[]', '["Synthetic limitation"]', 1, 'low', '{"narrative":"Synthetic professor edit"}');

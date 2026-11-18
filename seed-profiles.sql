-- Core operational profiles. Keep the total at or below 8; beyond that,
-- terminal tab/banner colour discrimination stops being a reliable cue.
INSERT INTO profile_themes (profile_id, color_int, color_css, color_label, updated_at_ms) VALUES
  ('desk-enam-01',   3718648,  '#38bdf8', 'sky-400',    CAST(unixepoch('subsec') * 1000 AS INTEGER)),
  ('desk-mut-prod',  15680580, '#ef4444', 'red-500',    CAST(unixepoch('subsec') * 1000 AS INTEGER)),
  ('desk-staging',   16096779, '#f59e0b', 'amber-500',  CAST(unixepoch('subsec') * 1000 AS INTEGER)),
  ('desk-dev-local', 2278750,  '#22c55e', 'green-500',  CAST(unixepoch('subsec') * 1000 AS INTEGER)),
  ('desk-research',  11032055, '#a855f7', 'purple-500', CAST(unixepoch('subsec') * 1000 AS INTEGER))
ON CONFLICT(profile_id) DO UPDATE SET
  color_int = excluded.color_int,
  color_css = excluded.color_css,
  color_label = excluded.color_label,
  updated_at_ms = excluded.updated_at_ms;

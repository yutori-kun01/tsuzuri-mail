-- 登録元のタグ名から「src:」を外す（画面で分かりにくいため）。種類は category = 'src' で引き続き区別する。
-- 同じ名前のタグが既にある場合は、重複を避けるためそのタグだけ元の名前のまま残す。
-- タグを名前で参照している場所（自動化のルール、一斉配信の宛先、ステップの条件、保存した宛先）も合わせて直す。

CREATE TEMP TABLE tz_tag_rename AS
SELECT t.id, t.name AS old_name, substr(t.name, 5) AS new_name
  FROM tags t
 WHERE t.name LIKE 'src:%'
   AND length(t.name) > 4
   AND NOT EXISTS (SELECT 1 FROM tags u WHERE u.name = substr(t.name, 5));

UPDATE tags SET name = r.new_name, category = 'src' FROM tz_tag_rename r WHERE tags.id = r.id;

UPDATE automation_rules SET trigger_value = r.new_name
  FROM tz_tag_rename r WHERE trigger_type = 'tag_added' AND trigger_value = r.old_name;
UPDATE automation_rules SET action_value = r.new_name
  FROM tz_tag_rename r WHERE action_type IN ('add_tag', 'remove_tag') AND action_value = r.old_name;

-- JSON の中のタグ名（"src:名前" という文字列そのもの）を置き換える
UPDATE broadcasts b SET segment_definition = replace(b.segment_definition::text, to_jsonb(r.old_name)::text, to_jsonb(r.new_name)::text)::jsonb
  FROM tz_tag_rename r WHERE b.segment_definition::text LIKE '%' || to_jsonb(r.old_name)::text || '%';
UPDATE sequence_steps s SET condition = replace(s.condition::text, to_jsonb(r.old_name)::text, to_jsonb(r.new_name)::text)::jsonb
  FROM tz_tag_rename r WHERE s.condition::text LIKE '%' || to_jsonb(r.old_name)::text || '%';
UPDATE segments g SET definition = replace(g.definition::text, to_jsonb(r.old_name)::text, to_jsonb(r.new_name)::text)::jsonb
  FROM tz_tag_rename r WHERE g.definition::text LIKE '%' || to_jsonb(r.old_name)::text || '%';

DROP TABLE tz_tag_rename;

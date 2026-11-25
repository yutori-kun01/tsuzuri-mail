-- 一覧での並び順（ドラッグで並べ替える）。NULL は作った順で末尾に並ぶ
ALTER TABLE sequences ADD COLUMN list_position integer;
ALTER TABLE forms ADD COLUMN list_position integer;

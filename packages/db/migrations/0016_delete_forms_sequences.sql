-- フォームとシナリオを削除できるようにする。
-- 同意の記録（consents）は法定の保存のため消さない。フォームを消したら form_id を NULL にし、
-- どのフォームだったかは削除の直前に evidence へ書き写す（アプリ側：services/deletion.ts）。
ALTER TABLE consents DROP CONSTRAINT consents_form_fk;
ALTER TABLE consents ADD CONSTRAINT consents_form_fk FOREIGN KEY (form_id) REFERENCES forms(id) ON DELETE SET NULL;

-- シナリオを消したら、それを始めるフォームは「シナリオなし（メルマガのみ）」に戻す
ALTER TABLE forms DROP CONSTRAINT forms_sequence_id_fkey;
ALTER TABLE forms ADD CONSTRAINT forms_sequence_id_fkey FOREIGN KEY (sequence_id) REFERENCES sequences(id) ON DELETE SET NULL;

-- タグを消したら、フォームの付与タグ・シナリオの完了タグは外す
ALTER TABLE forms DROP CONSTRAINT forms_tag_id_fkey;
ALTER TABLE forms ADD CONSTRAINT forms_tag_id_fkey FOREIGN KEY (tag_id) REFERENCES tags(id) ON DELETE SET NULL;
ALTER TABLE sequences DROP CONSTRAINT sequences_done_tag_id_fkey;
ALTER TABLE sequences ADD CONSTRAINT sequences_done_tag_id_fkey FOREIGN KEY (done_tag_id) REFERENCES tags(id) ON DELETE SET NULL;

-- 送信記録に件名を残す（シナリオやステップを消しても、配信ログで何のメールだったか分かるように）
ALTER TABLE messages ADD COLUMN subject text;
CREATE INDEX events_message_idx ON events (message_id, type) WHERE message_id IS NOT NULL;

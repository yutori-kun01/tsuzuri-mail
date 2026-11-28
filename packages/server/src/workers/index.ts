// Cloudflare Workers の入り口。中身は worker.ts（入り口のファイルは、処理の関数以外を export できないため分けている）
import { createWorker } from "./worker.js";

export default createWorker();

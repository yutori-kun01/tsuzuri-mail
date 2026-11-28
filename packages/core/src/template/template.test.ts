import { describe, expect, it } from "vitest";
import { scan, substitute, validateCustomKey, validateTemplate, type PlaceholderContext } from "./placeholders.js";
import { footerProblems, renderEmail } from "./render.js";

const ctx: PlaceholderContext = {
  builtins: {
    cancel: "https://example.com/u/TOKEN",
    settings: "https://example.com/p/TOKEN",
    name: "山田",
    date: "2026年11月13日",
    sender: "つづり通信",
  },
  custom: [
    { key: "lp_url", value: "https://example.com/lp", kind: "url" },
    { key: "特典名", value: "SEOチェックリスト", kind: "text" },
  ],
  attributes: { job: "編集者", empty: "" },
};

describe("scan / substitute", () => {
  it("replaces built-ins, Japanese aliases, custom keys and attributes", () => {
    expect(substitute("%name%さん %名前%さん %特典名% %attr.job%", ctx)).toBe("山田さん 山田さん SEOチェックリスト 編集者");
  });
  it("uses the fallback when the value is empty", () => {
    expect(substitute("%attr.empty|未設定% %attr.none|なし%", ctx)).toBe("未設定 なし");
    expect(substitute("%name|読者%さん", { ...ctx, builtins: {} })).toBe("読者さん");
  });
  it("treats %% as a literal percent sign", () => {
    expect(substitute("50%%オフ", ctx)).toBe("50%オフ");
    expect(scan("50%%オフ")).toHaveLength(0);
  });
  it("does not treat a percent followed by a space as a placeholder", () => {
    expect(substitute("50% と 30% です", ctx)).toBe("50% と 30% です");
  });
});

describe("validateTemplate", () => {
  it("reports typos so they are never sent raw", () => {
    const r = validateTemplate("%cancell% %lp_url% %attr.job% %配信解除%", ["lp_url"]);
    expect(r.ok).toBe(false);
    expect(r.unknown).toEqual(["cancell"]);
  });
});

describe("validateCustomKey", () => {
  it("rejects names that collide with built-ins or contain symbols", () => {
    expect(validateCustomKey("cancel")).toBeDefined();
    expect(validateCustomKey("配信解除")).toBeDefined();
    expect(validateCustomKey("a b")).toBeDefined();
    expect(validateCustomKey("attr_x")).toBeDefined();
    expect(validateCustomKey("lp_url")).toBeUndefined();
    expect(validateCustomKey("特典URL")).toBeUndefined();
  });
});

describe("renderEmail", () => {
  const base = {
    subject: "%name%さんへ：%特典名%",
    body: "こんにちは、%name%さん。\n\n[LPはこちら](%lp_url%)\n\n[外部記事](https://example.org/a?x=1&y=2)\n\n不要なら[配信解除](%cancel%)\n\n<b>%attr.job%</b>",
    context: ctx,
    footer: { senderName: "つづり通信", contact: "https://example.com/contact", senderInfoUrl: "https://example.com/legal" },
    unsubscribeUrl: "https://example.com/u/TOKEN",
    tracking: { clickUrl: (i: number) => `https://t.example.com/c/${i}`, openPixelUrl: "https://t.example.com/o/x" },
  };

  it("substitutes the subject", () => {
    expect(renderEmail(base).subject).toBe("山田さんへ：SEOチェックリスト");
  });

  it("tracks normal links but never the unsubscribe link", () => {
    const r = renderEmail(base);
    expect(r.links.map((l) => l.url)).toEqual(["https://example.com/lp", "https://example.org/a?x=1&y=2"]);
    expect(r.links.at(-1)?.isLast).toBe(true);
    expect(r.html).toContain('href="https://t.example.com/c/0"');
    expect(r.html).toContain('href="https://example.com/u/TOKEN"');
    expect(r.html).not.toContain("TZPH");
  });

  it("always adds the legal footer and the open pixel", () => {
    const r = renderEmail({ ...base, body: "本文だけ" });
    expect(r.html).toContain("送信者：つづり通信");
    expect(r.html).not.toContain("住所：");
    expect(r.html).toContain('href="https://example.com/legal">送信者情報（住所など）はこちら');
    expect(r.text).toContain("送信者情報（住所など）：https://example.com/legal");
    expect(r.html).toContain("配信停止");
    expect(r.html).toContain("https://t.example.com/o/x");
    expect(r.text).toContain("配信停止：https://example.com/u/TOKEN");
  });

  it("escapes values inserted into HTML", () => {
    const r = renderEmail({ ...base, context: { ...ctx, builtins: { ...ctx.builtins, name: "<script>x</script>" } } });
    expect(r.html).not.toContain("<script>x</script>");
    expect(r.html).toContain("&lt;script&gt;");
  });

  it("produces a plain-text version with resolved links", () => {
    const r = renderEmail(base);
    expect(r.text).toContain("こんにちは、山田さん。");
    expect(r.text).toContain("LPはこちら（https://example.com/lp）");
  });

  it("works without tracking", () => {
    const { tracking: _t, ...noTracking } = base;
    const r = renderEmail(noTracking);
    expect(r.links).toHaveLength(0);
    expect(r.html).toContain('href="https://example.com/lp"');
  });

  it("keeps the page white and puts only the footer on a gray band", () => {
    const r = renderEmail({ ...base, body: "本文だけ" });
    expect(r.html).toContain('<body style="margin:0;padding:0;background:#ffffff">');
    expect(r.html).not.toContain("#f6f6f4");
    const band = r.html.indexOf("background:#f4f4f2");
    expect(band).toBeGreaterThan(r.html.indexOf("本文だけ"));
    expect(band).toBeLessThan(r.html.indexOf("送信者：つづり通信"));
  });

  it("styles Markdown simply (no colored boxes)", () => {
    const r = renderEmail({ ...base, body: "# 見出し\n\n段落\n\n> 引用" });
    expect(r.html).toContain('<h1 style="font-size:20px;');
    expect(r.html).toContain('<p style="margin:0 0 1em">段落</p>');
    expect(r.html).toContain('<blockquote style="margin:0 0 1em;');
  });
});

describe("renderEmail with HTML bodies", () => {
  const footer = { senderName: "つづり通信", contact: "https://example.com/contact", senderInfoUrl: "https://example.com/legal" };
  const tracking = { clickUrl: (i: number) => `https://t.example.com/c/${i}`, openPixelUrl: "https://t.example.com/o/x" };

  it("keeps a full HTML document and inserts the footer before </body>", () => {
    const body = `<!doctype html><html><head><style>.x{color:red}</style></head><body><table><tr><td class="x">%name%さん</td></tr></table>
<a class="btn" href="%lp_url%">LP</a> <a href='https://example.org/b'>B</a> <a href="%cancel%">解除</a>
<img src="%lp_url%/hero.png" alt=""></body></html>`;
    const r = renderEmail({ subject: "s", body, format: "html", context: ctx, footer, unsubscribeUrl: "https://example.com/u/T", tracking });
    expect(r.html.startsWith("<!doctype html><html><head><style>")).toBe(true);
    expect(r.html).toContain('<td class="x">山田さん</td>');
    expect(r.html).toContain('<a class="btn" href="https://t.example.com/c/0"');
    expect(r.html).toContain('href="https://t.example.com/c/1"');
    expect(r.html).toContain('href="https://example.com/u/TOKEN"');
    // 属性の中の URL 型の値はリンクに変えない
    expect(r.html).toContain('<img src="https://example.com/lp/hero.png"');
    expect(r.html.indexOf("送信者：つづり通信")).toBeLessThan(r.html.indexOf("</body>"));
    expect(r.links.map((l) => l.url)).toEqual(["https://example.com/lp", "https://example.org/b"]);
  });

  it("wraps an HTML fragment in the layout and builds a readable text version", () => {
    const r = renderEmail({
      subject: "s",
      body: "<h2>見出し</h2><p>%name%さん、<a href=\"https://example.org/x\">記事</a>です。</p><ul><li>一つ目</li></ul>",
      format: "html",
      context: ctx,
      footer,
      unsubscribeUrl: "https://example.com/u/T",
    });
    expect(r.html).toContain("<!doctype html>");
    expect(r.text).toContain("見出し");
    expect(r.text).toContain("山田さん、記事（https://example.org/x）です。");
    expect(r.text).toContain("・一つ目");
    expect(r.text).not.toContain("<");
  });
});

describe("footer templates", () => {
  const withInfo: PlaceholderContext = { ...ctx, builtins: { ...ctx.builtins, sender_info: "https://example.com/legal" } };
  const tpl = "このメールは %sender% からお送りしています。\n[配信停止](%cancel%) ｜ [送信者情報](%sender_info%)";

  it("lists the required parts that are missing", () => {
    expect(footerProblems(tpl)).toEqual([]);
    expect(footerProblems("%送信者% [停止](%配信停止%)")).toEqual(["%sender_info%（送信者情報のページ。住所・問い合わせ先を載せる）"]);
    expect(footerProblems("")).toHaveLength(3);
  });

  it("renders the template instead of the standard footer, without click tracking", () => {
    const r = renderEmail({
      subject: "s",
      body: "[記事](https://example.org/a)",
      context: withInfo,
      footer: { senderName: "つづり通信", contact: "https://example.com/contact" },
      footerTemplate: tpl,
      unsubscribeUrl: "https://example.com/u/TOKEN",
      tracking: { clickUrl: (i: number) => `https://t.example.com/c/${i}` },
    });
    expect(r.links).toHaveLength(1); // 本文のリンクだけ
    expect(r.html).toContain('href="https://example.com/u/TOKEN"');
    expect(r.html).toContain('href="https://example.com/legal"');
    expect(r.html).not.toContain("お問い合わせ：");
    expect(r.text).toContain("このメールは つづり通信 からお送りしています。");
    // Web 版（配信停止 URL なし）では使わない
    const web = renderEmail({ subject: "s", body: "b", context: withInfo, footer: { senderName: "つづり通信", contact: "c" }, footerTemplate: tpl, unsubscribeUrl: "" });
    expect(web.html).not.toContain("u/TOKEN");
  });
});

describe("HTML bodies keep URL encodings and CSS percentages", () => {
  const footer = { senderName: "つづり通信", contact: "https://example.com/contact" };
  const html = `<div style="width:100%;height:50%"><a href="https://example.com/search?q=%E3%81%82%E3%81%84&amp;r=%E3%81%82abc%E3%81%84">検索</a>
<a href="%lp_url%">LP</a> %name%さん %attr.job% 50%% %unknown% <a href="%cancel%">停止</a></div>`;

  it("only treats registered names as placeholders in html mode", () => {
    expect(scan(html, { html: true, customKeys: ["lp_url"] }).map((t) => t.name)).toEqual(["lp_url", "name", "attr.job", "cancel"]);
    expect(validateTemplate(html, ["lp_url"], { html: true }).ok).toBe(true);
    // Markdown 側は今までどおり、知らない名前をエラーにする
    expect(validateTemplate("%cancell%", [], {}).unknown).toEqual(["cancell"]);
  });

  it("finds a placeholder right after a percent-encoded byte", () => {
    expect(scan("https://example.com/?a=%E3%name%", { html: true }).map((t) => t.name)).toEqual(["name"]);
  });

  it("renders without touching encoded URLs, CSS or unknown tokens", () => {
    const r = renderEmail({ subject: "件名", body: html, format: "html", context: ctx, footer, unsubscribeUrl: "https://example.com/u/TOKEN" });
    expect(r.html).toContain('style="width:100%;height:50%"');
    expect(r.html).toContain("https://example.com/search?q=%E3%81%82%E3%81%84&amp;r=%E3%81%82abc%E3%81%84");
    expect(r.html).toContain('href="https://example.com/lp"');
    expect(r.html).toContain("山田さん 編集者 50%% %unknown%");
    expect(r.html).toContain('href="https://example.com/u/TOKEN"');
  });

  it("tracks encoded URLs as they are", () => {
    const r = renderEmail({
      subject: "件名",
      body: '<a href="https://example.com/?q=%E3%81%82">あ</a>',
      format: "html",
      context: ctx,
      footer,
      unsubscribeUrl: "https://example.com/u/TOKEN",
      tracking: { clickUrl: (i) => `https://t.example.com/c/${i}` },
    });
    expect(r.links).toEqual([{ index: 0, url: "https://example.com/?q=%E3%81%82", isLast: true }]);
  });
});

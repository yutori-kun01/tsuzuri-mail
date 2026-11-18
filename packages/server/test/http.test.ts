import { createToken } from "@tsuzuri/core";
import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/http/app.js";
import { sendMessage } from "../src/services/sending.js";
import { unsubscribe } from "../src/services/subscription.js";
import { createEnv, type TestEnv } from "./helpers.js";

let env: TestEnv;
let queued: string[];
let app: ReturnType<typeof createApp>;

beforeEach(async () => {
  env = await createEnv();
  queued = [];
  app = createApp(async () => env.ctx, { enqueue: async (ids) => void queued.push(...ids), privacyUrl: "https://example.com/privacy" });
  await env.ctx.db.query(
    "INSERT INTO forms (slug, name, consent_text_version) VALUES ('news', 'ニュースレター', 'v1')",
  );
});

const form = (data: Record<string, string>) =>
  new Request("http://x/f/news", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(data).toString(),
  });

describe("public HTTP", () => {
  it("serves the hosted form with the privacy notice", async () => {
    const res = await app.request("/f/news");
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("ニュースレター");
    expect(html).toContain("https://example.com/privacy");
    expect((await app.request("/f/none")).status).toBe(404);
  });

  it("accepts a signup, queues the confirmation mail and confirms", async () => {
    const res = await app.request(form({ email: "reader@example.com", name: "山田" }));
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("https://mail.example.com/f/news/sent");
    expect(queued).toHaveLength(1);

    await sendMessage(env.ctx, queued[0]!);
    const token = /\/confirm\/([^"<\s]+)/.exec(env.provider.sent[0]!.html)![1]!;
    const ok = await app.request(`/confirm/${token}`);
    expect(ok.status).toBe(200);
    expect(await ok.text()).toContain("登録が完了しました");
    expect((await app.request("/confirm/bad.token")).status).toBe(400);
  });

  it("silently drops honeypot submissions and rejects invalid addresses", async () => {
    expect((await app.request(form({ email: "bot@example.com", website: "spam" }))).status).toBe(303);
    expect(queued).toHaveLength(0);
    expect((await app.request(form({ email: "not-an-email" }))).status).toBe(400);
  });

  it("supports RFC 8058 one-click unsubscribe", async () => {
    await app.request(form({ email: "reader@example.com" }));
    const [c] = await env.ctx.db.query<{ id: string }>("SELECT id FROM contacts");
    const token = createToken("unsubscribe", c!.id, env.ctx.secret);

    const confirmPage = await app.request(`/u/${token}`);
    expect(await confirmPage.text()).toContain("配信を停止しますか");

    const res = await app.request(`/u/${token}`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "List-Unsubscribe=One-Click",
    });
    expect(res.status).toBe(200);
    const [after] = await env.ctx.db.query<{ status: string }>("SELECT status FROM contacts");
    expect(after!.status).toBe("unsubscribed");
    expect((await app.request("/u/forged.x", { method: "POST" })).status).toBe(400);
  });

  it("always returns the tracking pixel, even for bad tokens", async () => {
    const res = await app.request("/o/whatever.gif");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/gif");
  });

  it("renders the web version without personal links", async () => {
    const [b] = await env.ctx.db.query<{ id: string }>(
      "INSERT INTO broadcasts (subject, body_markdown, status) VALUES ('第1号', '%name%さん、こんにちは。[配信解除](%cancel%)', 'sent') RETURNING id",
    );
    const res = await app.request(`/w/${b!.id}?r=sometoken`);
    const html = await res.text();
    expect(html).toContain("読者さん、こんにちは。");
    expect(html).not.toContain("/u/");
    expect(html).toContain("tz-end");
    expect((await app.request("/w/00000000-0000-0000-0000-000000000000")).status).toBe(404);
  });
});

describe("per-form pages and security", () => {
  beforeEach(async () => {
    await env.ctx.db.query(
      `INSERT INTO forms (slug, name, consent_text_version, page_title, page_description, button_label, sent_url,
                          confirmed_message, allowed_origins)
       VALUES ('camp', 'キャンペーン', 'v1', '特典を受け取る', '説明文です', '受け取る', 'https://example.com/check-mail',
               'ようこそ！', ARRAY['https://blog.example.com'])`,
    );
  });

  const post = (headers: Record<string, string>, email = "a@example.com") =>
    app.request(
      new Request("http://x/f/camp", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", ...headers },
        body: new URLSearchParams({ email }).toString(),
      }),
    );

  it("uses the form's own title, description, button and redirect", async () => {
    const html = await (await app.request("/f/camp")).text();
    expect(html).toContain("特典を受け取る");
    expect(html).toContain("説明文です");
    expect(html).toContain(">受け取る</button>");
    const res = await post({ origin: "https://blog.example.com" });
    expect(res.headers.get("location")).toBe("https://example.com/check-mail");
  });

  it("rejects posts from sites that are not allowed", async () => {
    expect((await post({ origin: "https://evil.example.net" })).status).toBe(403);
    expect((await post({})).status).toBe(403);
    // 自前のフォームページからは許可
    expect((await post({ origin: "https://mail.example.com" })).status).toBe(303);
  });

  it("outputs an embeddable form tag", async () => {
    const snippet = await (await app.request("/f/camp/embed")).text();
    expect(snippet).toContain('<form class="tsuzuri-form" method="post" action="https://mail.example.com/f/camp">');
    expect(snippet).toContain('name="website"');
    expect(snippet).toContain(">受け取る</button>");
  });

  it("caps confirmation mails per address per day", async () => {
    for (let i = 0; i < 5; i++) {
      await post({ origin: "https://blog.example.com" }, "victim@example.com");
      for (const id of new Set(queued)) await sendMessage(env.ctx, id);
    }
    expect(env.provider.sent).toHaveLength(3);
  });

  it("shows the sender information page and sets security headers", async () => {
    const res = await app.request("/legal");
    const html = await res.text();
    expect(html).toContain("東京都千代田区1-1-1");
    expect(res.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    expect(res.headers.get("strict-transport-security")).toContain("max-age");
  });

  it("rejects oversized requests", async () => {
    const res = await post({ origin: "https://blog.example.com" }, "a".repeat(20_000) + "@example.com");
    expect(res.status).toBe(413);
  });
});

describe("form fields and acceptance window", () => {
  const fields = [
    { key: "name", label: "ニックネーム", type: "text", required: false, enabled: true, options: [], defaultValue: "" },
    { key: "job", label: "職業", type: "select", required: true, enabled: true, options: ["会社員", "個人事業"], defaultValue: "" },
    { key: "likes", label: "興味", type: "checkbox", required: false, enabled: true, options: ["SNS", "AI"], defaultValue: "" },
    { key: "src", label: "経路", type: "hidden", required: false, enabled: true, options: [], defaultValue: "blog" },
  ];
  beforeEach(async () => {
    await env.ctx.db.query("UPDATE forms SET fields = $1::jsonb WHERE slug = 'news'", [JSON.stringify(fields)]);
  });
  const send = (pairs: [string, string][]) =>
    app.request(
      new Request("http://x/f/news", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams(pairs).toString(),
      }),
    );

  it("shows the configured fields on the page and in the embed tag", async () => {
    const html = await (await app.request("/f/news")).text();
    expect(html).toContain("ニックネーム（任意）");
    expect(html).toContain("職業（必須）");
    expect(html).toContain('type="checkbox" name="likes" value="AI"');
    expect(html).toContain('type="hidden" name="src" value="blog"');
    const snippet = await (await app.request("/f/news/embed")).text();
    expect(snippet).toContain('<select class="tsuzuri-input" name="job" required>');
  });

  it("saves the values as reader attributes", async () => {
    const res = await send([["email", "a@example.com"], ["name", "やま"], ["job", "会社員"], ["likes", "AI"], ["likes", "SNS"]]);
    expect(res.status).toBe(303);
    const [c] = await env.ctx.db.query<{ display_name: string; attributes: Record<string, string> }>("SELECT display_name, attributes FROM contacts");
    expect(c).toEqual({ display_name: "やま", attributes: { job: "会社員", likes: "SNS, AI", src: "blog" } });
  });

  it("re-shows the form with the error and the typed values", async () => {
    const res = await send([["email", "a@example.com"], ["name", "やま"]]);
    expect(res.status).toBe(400);
    const html = await res.text();
    expect(html).toContain("「職業」を入力してください");
    expect(html).toContain('value="a@example.com"');
    expect((await env.ctx.db.query("SELECT 1 FROM contacts")).length).toBe(0);
  });

  it("closes the form outside the acceptance window", async () => {
    await env.ctx.db.query("UPDATE forms SET accept_until = $1 WHERE slug = 'news'", [new Date(env.ctx.now().getTime() - 60_000)]);
    expect((await app.request("/f/news")).status).toBe(404);
    expect((await send([["email", "a@example.com"], ["job", "会社員"]])).status).toBe(404);
  });
});

describe("per-scenario sender", () => {
  it("sends the confirmation mail from the sender of the scenario the form starts", async () => {
    env.ctx.settings.sendingDomains = ["news.other.jp"];
    const [s] = await env.ctx.db.query<{ id: string }>(
      "INSERT INTO sequences (slug, name, status, from_name, from_address) VALUES ('b', 'B', 'active', 'ブランドB', 'hello@news.other.jp') RETURNING id",
    );
    await env.ctx.db.query("UPDATE forms SET sequence_id = $1 WHERE slug = 'news'", [s!.id]);
    await app.request(form({ email: "a@example.com" }));
    for (const id of queued) await sendMessage(env.ctx, id);
    const optin = env.provider.sent.at(-1)!;
    expect(optin.from).toEqual({ address: "hello@news.other.jp", name: "ブランドB" });
    expect(optin.replyTo).toBe(env.ctx.settings.replyTo);
  });
});

describe("single opt-in forms", () => {
  beforeEach(async () => {
    await env.ctx.db.query("UPDATE forms SET double_optin = false, confirmed_message = 'ようこそ' WHERE slug = 'news'");
  });

  it("completes the signup on submit without a confirmation mail", async () => {
    const res = await app.request(form({ email: "a@example.com" }));
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("https://mail.example.com/f/news/done");
    expect(queued).toEqual([]);
    const [c] = await env.ctx.db.query<{ status: string }>("SELECT status FROM contacts");
    expect(c!.status).toBe("active");
    const [co] = await env.ctx.db.query<{ confirmed_at: Date | null; consent_text_version: string }>("SELECT confirmed_at, consent_text_version FROM consents");
    expect(co!.confirmed_at).not.toBeNull();
    expect(await (await app.request("/f/news/done")).text()).toContain("ようこそ");
  });

  it("still asks for confirmation when an unsubscribed address signs up again", async () => {
    await app.request(form({ email: "a@example.com" }));
    const [c] = await env.ctx.db.query<{ id: string }>("SELECT id FROM contacts");
    await unsubscribe(env.ctx, c!.id);
    const res = await app.request(form({ email: "a@example.com" }));
    expect(res.headers.get("location")).toBe("https://mail.example.com/f/news/sent");
    expect(queued.length).toBe(1);
    const [after] = await env.ctx.db.query<{ status: string }>("SELECT status FROM contacts");
    expect(after!.status).toBe("unsubscribed");
  });
});

describe("email typo check and signup routes", () => {
  const send = (pairs: [string, string][]) =>
    app.request(
      new Request("http://x/f/news", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(pairs).toString() }),
    );

  it("asks before registering a likely typo, and lets the reader keep it", async () => {
    const res = await send([["email", "taro@gmial.com"]]);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("taro@gmail.com");
    expect(html).toContain('name="email_keep" value="taro@gmial.com"');
    expect((await env.ctx.db.query("SELECT 1 FROM contacts")).length).toBe(0);

    await send([["email", "taro@gmail.com"], ["email_checked", "1"]]);
    const [ch] = await env.ctx.db.query<{ address: string }>("SELECT address FROM channels");
    expect(ch!.address).toBe("taro@gmail.com");

    await send([["email", "taro@gmail.com"], ["email_checked", "1"], ["email_keep", "jiro@gmial.com"]]);
    const rows = await env.ctx.db.query<{ address: string }>("SELECT address FROM channels ORDER BY address");
    expect(rows.map((r) => r.address)).toEqual(["jiro@gmial.com", "taro@gmail.com"]);
  });

  it("returns the suggestion to JSON clients", async () => {
    const res = await app.request(
      new Request("http://x/f/news", { method: "POST", headers: { "content-type": "application/json", accept: "application/json" }, body: JSON.stringify({ email: "a@yahoo.jp" }) }),
    );
    expect(await res.json()).toEqual({ ok: false, error: "email-typo", suggestion: "a@yahoo.co.jp" });
  });

  it("records the signup route from ?r= and ignores unknown routes", async () => {
    await env.ctx.db.query("INSERT INTO signup_routes (code, name) VALUES ('x-profile', 'X プロフィール')");
    const page = await (await app.request("/f/news?r=x-profile")).text();
    expect(page).toContain('<input type="hidden" name="r" value="x-profile">');
    await send([["email", "a@example.com"], ["r", "x-profile"]]);
    await send([["email", "b@example.com"], ["r", "nope"]]);
    const rows = await env.ctx.db.query<{ address: string; route: string | null }>(
      "SELECT ch.address, r.code AS route FROM consents co JOIN channels ch ON ch.id = co.channel_id LEFT JOIN signup_routes r ON r.id = co.route_id ORDER BY ch.address",
    );
    expect(rows).toEqual([{ address: "a@example.com", route: "x-profile" }, { address: "b@example.com", route: null }]);
  });
});

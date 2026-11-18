import { appendFile, readFile, writeFile } from "node:fs/promises";
import { createInterface } from "node:readline";
import { generateTotpSecret, hashPassword, totpUri, verifyTotp } from "@tsuzuri/core";

/** 入力を画面に表示せずに読む（パスワード用） */
function askHidden(question: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    const out = rl as unknown as { _writeToOutput?: (s: string) => void };
    process.stdout.write(question);
    out._writeToOutput = () => {};
    rl.question("", (answer) => {
      rl.close();
      process.stdout.write("\n");
      resolve(answer);
    });
  });
}

function ask(question: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, (a) => {
      rl.close();
      resolve(a.trim());
    });
  });
}

/** .env の KEY=... を置き換える（無ければ追記） */
async function setEnv(file: string, key: string, value: string): Promise<void> {
  const line = `${key}='${value}'`;
  let src = "";
  try {
    src = await readFile(file, "utf8");
  } catch {
    await writeFile(file, "");
  }
  const re = new RegExp(`^${key}=.*$`, "m");
  if (re.test(src)) await writeFile(file, src.replace(re, line));
  else await appendFile(file, `${src.endsWith("\n") || src === "" ? "" : "\n"}${line}\n`);
}

/**
 * 管理者ログインの初期設定。
 * - パスワード（12 文字以上）を 2 回入力 → scrypt でハッシュ化
 * - 認証アプリ用の鍵を作り、登録用の情報を表示 → 今のコードを入力して確認
 * - 保存先：--local なら .env、--ssm なら AWS の SSM パラメータストア（SecureString）
 */
export async function adminSetup(target: "local" | "ssm", paramPrefix = "/tsuzuri/", envFile = ".env"): Promise<void> {
  const pw1 = await askHidden("管理画面のパスワード（12 文字以上）：");
  const pw2 = await askHidden("もう一度：");
  if (pw1 !== pw2) throw new Error("パスワードが一致しません");
  const passwordHash = hashPassword(pw1);

  const secret = generateTotpSecret();
  console.log("\n認証アプリ（Google Authenticator、1Password など）に次を登録してください。");
  console.log("・手入力する場合の鍵：", secret.replace(/(.{4})/g, "$1 ").trim());
  console.log("・QR コードを作る場合の URI：", totpUri(secret, "admin"));
  console.log("※ この鍵は認証アプリに登録したら、どこにも保存しないでください。\n");
  for (let i = 0; i < 3; i++) {
    const code = await ask("認証アプリに表示された 6 桁のコード：");
    if (verifyTotp(secret, code, new Date())) {
      if (target === "local") {
        await setEnv(envFile, "ADMIN_PASSWORD_HASH", passwordHash);
        await setEnv(envFile, "ADMIN_TOTP_SECRET", secret);
        console.log(`${envFile} に保存しました。VPS では作り直すと反映されます（Docker 版：docker compose -f deploy/docker/compose.yml up -d --force-recreate tsuzuri、systemd 版：sudo systemctl restart tsuzuri）`);
      } else {
        const { PutParameterCommand, SSMClient } = await import("@aws-sdk/client-ssm");
        const ssm = new SSMClient({ region: process.env.AWS_REGION ?? "ap-northeast-1" });
        for (const [name, value] of [
          [`${paramPrefix}admin-password-hash`, passwordHash],
          [`${paramPrefix}admin-totp-secret`, secret],
        ] as const) {
          await ssm.send(new PutParameterCommand({ Name: name, Value: value, Type: "SecureString", Overwrite: true }));
        }
        console.log("SSM パラメータストアに保存しました。反映には Lambda の再起動が必要です（次のデプロイ、または数分〜数十分で自動的に入れ替わります）");
      }
      return;
    }
    console.log("コードが一致しません。時刻のずれがないか確認して、もう一度入力してください。");
  }
  throw new Error("コードの確認に 3 回失敗しました。最初からやり直してください");
}

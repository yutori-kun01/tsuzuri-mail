import type { MailProvider, OutgoingMessage, SendResult } from "@tsuzuri/core";

/** ローカル開発用：送らずに標準出力へ要約を出す（宛先は伏せる） */
export class ConsoleProvider implements MailProvider {
  readonly name = "console";
  async send(m: OutgoingMessage): Promise<SendResult> {
    console.log(`[mail] ${m.idempotencyKey} subject="${m.subject}"\n${m.text}\n`);
    return { providerMessageId: `console-${m.idempotencyKey}` };
  }
}

import * as cdk from "aws-cdk-lib";
import * as cloudwatch from "aws-cdk-lib/aws-cloudwatch";
import * as cwActions from "aws-cdk-lib/aws-cloudwatch-actions";
import * as iam from "aws-cdk-lib/aws-iam";
import * as ses from "aws-cdk-lib/aws-ses";
import * as sns from "aws-cdk-lib/aws-sns";
import * as subs from "aws-cdk-lib/aws-sns-subscriptions";
import * as sqs from "aws-cdk-lib/aws-sqs";
import type { Construct } from "constructs";

export interface TsuzuriVpsConfig {
  domain: string;
  sendingSubdomain: string;
  manageIdentity: boolean;
  /** VPS の固定 IP。指定すると、アクセスキーはこの IP からしか使えない（漏れたときの被害を抑える） */
  vpsIp: string;
  /** VPS の IPv6 アドレス（任意）。AWS への通信が IPv6 で出る構成のときだけ指定する */
  vpsIpv6?: string;
  /**
   * SES がサンドボックス中か。サンドボックス中は、宛先（検証済みのテスト用アドレス）の ID も
   * 送信の権限の対象になることがあるため、同じアカウント・リージョンの ID への送信を許可する。
   * 送信元は ses:FromAddress、接続元は aws:SourceIp で引き続き制限される。本番承認後は false にして再デプロイする。
   */
  sesSandbox: boolean;
  /**
   * 追加の送信ドメイン（シナリオ・一斉配信ごとに別のドメインから送るため）。
   * ここに書いたドメインは、このスタックが SES の ID（Easy DKIM、MAIL FROM は bounce.<ドメイン>）を作り、送信の権限にも加える。
   * DNS レコードは管理画面の「送信ドメイン」に表示されるので、ドメインの DNS に登録する。
   */
  extraSendingDomains?: string[];
  alertEmail: string;
}

/**
 * VPS で動かす場合の AWS 側（SES まわりだけ）。
 * - 設定セット（抑制リスト、評判メトリクス）と、配信イベント → SNS → SQS
 * - VPS 用の IAM ユーザー（送信とイベントの受け取りだけ。送信元ドメインと送信元 IP で制限）
 * - バウンス率・苦情率・イベントの滞留の通知
 * アクセスキーはこのスタックでは作らない（作成と保管はオーナーが行う。docs/vps.md）。
 */
export class TsuzuriVpsStack extends cdk.Stack {
  constructor(scope: Construct, id: string, cfg: TsuzuriVpsConfig, props?: cdk.StackProps) {
    super(scope, id, props);
    const sendingDomain = `${cfg.sendingSubdomain}.${cfg.domain}`;
    const extraDomains = [...new Set(cfg.extraSendingDomains ?? [])].filter((d) => d !== sendingDomain);
    for (const d of extraDomains) {
      if (!/^([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(d)) throw new Error(`送信ドメインの形が正しくありません: ${d}`);
    }
    const allDomains = [sendingDomain, ...extraDomains];
    const identityArn = (d: string) => this.formatArn({ service: "ses", resource: "identity", resourceName: d });

    const configSet = new ses.ConfigurationSet(this, "ConfigSet", {
      configurationSetName: "tsuzuri",
      reputationMetrics: true,
      sendingEnabled: true,
      suppressionReasons: ses.SuppressionReasons.BOUNCES_AND_COMPLAINTS,
    });
    if (cfg.manageIdentity) {
      new ses.EmailIdentity(this, "Identity", {
        identity: ses.Identity.domain(sendingDomain),
        mailFromDomain: `bounce.${sendingDomain}`,
        configurationSet: configSet,
      });
    }
    for (const d of extraDomains) {
      new ses.EmailIdentity(this, `Identity-${d.replace(/[^a-z0-9]/g, "-")}`, {
        identity: ses.Identity.domain(d),
        mailFromDomain: `bounce.${d}`,
        configurationSet: configSet,
      });
    }

    // 配信イベント → SNS → SQS（VPS が取りに行く。VPS が止まっていても 14 日間は溜まる）
    const topic = new sns.Topic(this, "SesEvents");
    configSet.addEventDestination("ToSns", {
      destination: ses.EventDestination.snsTopic(topic),
      events: [ses.EmailSendingEvent.DELIVERY, ses.EmailSendingEvent.BOUNCE, ses.EmailSendingEvent.COMPLAINT, ses.EmailSendingEvent.REJECT],
    });
    const dlq = new sqs.Queue(this, "SesEventsDlq", { retentionPeriod: cdk.Duration.days(14), enforceSSL: true });
    const queue = new sqs.Queue(this, "SesEventsQueue", {
      retentionPeriod: cdk.Duration.days(14),
      visibilityTimeout: cdk.Duration.seconds(60),
      deadLetterQueue: { queue: dlq, maxReceiveCount: 5 },
      enforceSSL: true,
    });
    topic.addSubscription(new subs.SqsSubscription(queue, { rawMessageDelivery: true }));

    // VPS 用の IAM ユーザー（最小権限）
    const user = new iam.User(this, "VpsUser", { userName: "tsuzuri-vps" });
    // 接続元の制限。IPv4 は /32、IPv6 は /128（範囲で書かれていればそのまま）
    const cidr = (ip: string, bits: number) => (ip.includes("/") ? ip : `${ip}/${bits}`);
    const sourceIps = [
      ...(cfg.vpsIp ? [cidr(cfg.vpsIp, 32)] : []),
      ...(cfg.vpsIpv6 ? [cidr(cfg.vpsIpv6, 128)] : []),
    ];
    const fromIp = sourceIps.length ? { IpAddress: { "aws:SourceIp": sourceIps } } : {};
    user.addToPolicy(
      new iam.PolicyStatement({
        sid: "SendFromOwnDomainOnly",
        actions: ["ses:SendEmail", "ses:SendRawEmail"],
        resources: [
          // サンドボックス中は宛先の ID も対象になりうるので、このアカウント・リージョンの ID すべて
          ...(cfg.sesSandbox ? [identityArn("*")] : allDomains.map(identityArn)),
          this.formatArn({ service: "ses", resource: "configuration-set", resourceName: configSet.configurationSetName }),
        ],
        conditions: {
          StringLike: { "ses:FromAddress": allDomains.length === 1 ? `*@${sendingDomain}` : allDomains.map((d) => `*@${d}`) },
          ...fromIp,
        },
      }),
    );
    user.addToPolicy(
      new iam.PolicyStatement({
        sid: "ReadSesEvents",
        actions: ["sqs:ReceiveMessage", "sqs:DeleteMessage", "sqs:GetQueueAttributes"],
        resources: [queue.queueArn],
        ...(sourceIps.length ? { conditions: fromIp } : {}),
      }),
    );
    // 自己点検（doctor）が SES の状態を読むための読み取り専用の権限。変更はできない
    const readOnlyCond = sourceIps.length ? { conditions: fromIp } : {};
    user.addToPolicy(
      new iam.PolicyStatement({
        sid: "ReadSesSetup",
        actions: ["ses:GetEmailIdentity", "ses:GetConfigurationSet", "ses:GetConfigurationSetEventDestinations"],
        resources: [
          ...allDomains.map(identityArn),
          this.formatArn({ service: "ses", resource: "configuration-set", resourceName: configSet.configurationSetName }),
        ],
        ...readOnlyCond,
      }),
    );
    user.addToPolicy(
      new iam.PolicyStatement({
        sid: "ReadSesAccount",
        // GetAccount はリソースを指定できない（送信枠・本番アクセス・抑制リストの設定を読むだけ）
        actions: ["ses:GetAccount"],
        resources: ["*"],
        ...readOnlyCond,
      }),
    );

    if (cfg.alertEmail) {
      const alerts = new sns.Topic(this, "Alerts");
      alerts.addSubscription(new subs.EmailSubscription(cfg.alertEmail));
      const action = new cwActions.SnsAction(alerts);
      const alarm = (id: string, metric: cloudwatch.IMetric, threshold: number, desc: string) => {
        new cloudwatch.Alarm(this, id, {
          metric,
          threshold,
          evaluationPeriods: 1,
          comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
          treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
          alarmDescription: desc,
        }).addAlarmAction(action);
      };
      alarm(
        "BounceRate",
        new cloudwatch.Metric({ namespace: "AWS/SES", metricName: "Reputation.BounceRate", statistic: "Maximum", period: cdk.Duration.hours(1) }),
        0.04,
        "バウンス率が4%を超えました（SES の審査対象になりうる水準の手前）",
      );
      alarm(
        "ComplaintRate",
        new cloudwatch.Metric({ namespace: "AWS/SES", metricName: "Reputation.ComplaintRate", statistic: "Maximum", period: cdk.Duration.hours(1) }),
        0.001,
        "苦情率が0.1%を超えました",
      );
      // イベントが 1 時間以上取りに来られていない＝VPS のプログラムが止まっている可能性
      alarm(
        "EventsNotConsumed",
        queue.metricApproximateAgeOfOldestMessage({ period: cdk.Duration.minutes(15) }),
        3600,
        "バウンス・苦情のイベントが 1 時間以上処理されていません（VPS のプログラムが止まっていないか確認）",
      );
      alarm("EventsDlq", dlq.metricApproximateNumberOfMessagesVisible(), 1, "処理できない SES イベントがあります");
    }

    new cdk.CfnOutput(this, "SesEventsQueueUrl", { value: queue.queueUrl });
    new cdk.CfnOutput(this, "ConfigurationSet", { value: configSet.configurationSetName });
    new cdk.CfnOutput(this, "IamUser", { value: user.userName });
    new cdk.CfnOutput(this, "CreateAccessKey", { value: `aws iam create-access-key --user-name ${user.userName}` });
  }
}

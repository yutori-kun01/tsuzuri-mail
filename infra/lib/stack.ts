import { fileURLToPath } from "node:url";
import * as cdk from "aws-cdk-lib";
import * as apigw from "aws-cdk-lib/aws-apigatewayv2";
import { HttpLambdaIntegration } from "aws-cdk-lib/aws-apigatewayv2-integrations";
import * as acm from "aws-cdk-lib/aws-certificatemanager";
import * as cloudwatch from "aws-cdk-lib/aws-cloudwatch";
import * as cwActions from "aws-cdk-lib/aws-cloudwatch-actions";
import * as events from "aws-cdk-lib/aws-events";
import * as targets from "aws-cdk-lib/aws-events-targets";
import * as iam from "aws-cdk-lib/aws-iam";
import * as lambda from "aws-cdk-lib/aws-lambda";
import { SqsEventSource } from "aws-cdk-lib/aws-lambda-event-sources";
import * as nodejs from "aws-cdk-lib/aws-lambda-nodejs";
import * as logs from "aws-cdk-lib/aws-logs";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as ses from "aws-cdk-lib/aws-ses";
import * as sns from "aws-cdk-lib/aws-sns";
import * as subs from "aws-cdk-lib/aws-sns-subscriptions";
import * as sqs from "aws-cdk-lib/aws-sqs";
import type { Construct } from "constructs";

export interface TsuzuriConfig {
  /** 本体ドメイン（例 example.com） */
  domain: string;
  /** 送信用サブドメインの頭（例 ml → mail.example.com） */
  sendingSubdomain: string;
  /**
   * SES の ID（送信ドメイン）をこのスタックで作るか。
   * コンソールで作成済みなら false（既存の ID を権限の対象にするだけで、作り直さない）
   */
  manageIdentity: boolean;
  /** SES の送信レート上限（通/秒）。サンドボックスは 1。本番承認後に引き上げられた値に合わせる */
  maxSendRate: number;
  /** フォーム・配信停止・計測リンクのホスト名（例 mail.example.com）。空なら API Gateway の URL を使う */
  publicHost: string;
  fromLocalPart: string;
  paramPrefix: string;
  /** DB の CA 証明書の SHA-256 指紋（公開情報）。SSM の database-ca がこの CA であることを起動時に確かめる */
  databaseCaSha256: string;
  /** 以下はリポジトリに書かず、デプロイ時の環境変数で渡す */
  fromName: string;
  replyTo: string;
  privacyUrl: string;
  alertEmail: string;
}

const ENTRY = fileURLToPath(new URL("../../packages/server/src/handlers/lambda.ts", import.meta.url));

export class TsuzuriStack extends cdk.Stack {
  constructor(scope: Construct, id: string, cfg: TsuzuriConfig, props?: cdk.StackProps) {
    super(scope, id, props);

    const sendingDomain = `${cfg.sendingSubdomain}.${cfg.domain}`;
    const mailFromDomain = `bounce.${sendingDomain}`;

    // ---- SES：送信ドメイン、設定セット、配信イベント ----
    const configSet = new ses.ConfigurationSet(this, "ConfigSet", {
      configurationSetName: "tsuzuri",
      reputationMetrics: true,
      sendingEnabled: true,
      suppressionReasons: ses.SuppressionReasons.BOUNCES_AND_COMPLAINTS,
    });
    const identity = cfg.manageIdentity
      ? new ses.EmailIdentity(this, "Identity", {
          identity: ses.Identity.domain(sendingDomain),
          mailFromDomain,
          configurationSet: configSet,
        })
      : undefined;
    const identityArn = this.formatArn({ service: "ses", resource: "identity", resourceName: sendingDomain });
    const sesTopic = new sns.Topic(this, "SesEvents");
    configSet.addEventDestination("ToSns", {
      destination: ses.EventDestination.snsTopic(sesTopic),
      events: [
        ses.EmailSendingEvent.DELIVERY,
        ses.EmailSendingEvent.BOUNCE,
        ses.EmailSendingEvent.COMPLAINT,
        ses.EmailSendingEvent.REJECT,
      ],
    });

    // ---- 特典ファイル置き場（非公開。署名付き URL でのみ配布） ----
    const files = new s3.Bucket(this, "Files", {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      versioned: true,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    // ---- 毎晩のバックアップ（90 日で自動削除。データベース側の障害に備える） ----
    const backups = new s3.Bucket(this, "Backups", {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      lifecycleRules: [{ expiration: cdk.Duration.days(90) }],
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    // ---- 送信キュー ----
    const dlq = new sqs.Queue(this, "SendDlq", { retentionPeriod: cdk.Duration.days(14) });
    const queue = new sqs.Queue(this, "SendQueue", {
      visibilityTimeout: cdk.Duration.seconds(180),
      deadLetterQueue: { queue: dlq, maxReceiveCount: 5 },
    });

    // ---- Lambda 共通 ----
    const publicBaseUrlPlaceholder = cfg.publicHost ? `https://${cfg.publicHost}` : "";
    const env: Record<string, string> = {
      PARAM_PREFIX: cfg.paramPrefix,
      SES_CONFIGURATION_SET: configSet.configurationSetName,
      SEND_QUEUE_URL: queue.queueUrl,
      FILES_BUCKET: files.bucketName,
      MAIL_FROM_ADDRESS: `${cfg.fromLocalPart}@${sendingDomain}`,
      MAIL_FROM_NAME: cfg.fromName,
      ...(cfg.replyTo ? { MAIL_REPLY_TO: cfg.replyTo } : {}),
      ...(cfg.privacyUrl ? { PRIVACY_URL: cfg.privacyUrl } : {}),
      ...(cfg.databaseCaSha256 ? { DATABASE_CA_SHA256: cfg.databaseCaSha256 } : {}),
      NODE_OPTIONS: "--enable-source-maps",
    };
    const paramArn = this.formatArn({
      service: "ssm",
      resource: "parameter",
      resourceName: `${cfg.paramPrefix.replace(/^\//, "")}*`,
    });
    const fn = (name: string, handler: string, opts: Partial<nodejs.NodejsFunctionProps> = {}) => {
      const f = new nodejs.NodejsFunction(this, name, {
        entry: ENTRY,
        handler,
        runtime: lambda.Runtime.NODEJS_22_X,
        architecture: lambda.Architecture.ARM_64,
        memorySize: 512,
        timeout: cdk.Duration.seconds(30),
        environment: env,
        logGroup: new logs.LogGroup(this, `${name}Logs`, {
          retention: logs.RetentionDays.ONE_MONTH,
          removalPolicy: cdk.RemovalPolicy.DESTROY,
        }),
        bundling: {
          format: nodejs.OutputFormat.ESM,
          target: "node22",
          sourceMap: true,
          // pg の任意依存（ネイティブ版）は使わない
          externalModules: ["pg-native", "@aws-sdk/*"],
          banner: "import { createRequire } from 'module'; const require = createRequire(import.meta.url);",
        },
        ...opts,
      });
      f.addToRolePolicy(new iam.PolicyStatement({ actions: ["ssm:GetParameters"], resources: [paramArn] }));
      return f;
    };

    const apiFn = fn("Api", "api", { timeout: cdk.Duration.seconds(15) });
    const schedulerFn = fn("Scheduler", "scheduler", { timeout: cdk.Duration.seconds(55) });
    // SES の送信レートを超えないよう、1 通ごとに間を空ける。
    // キューの同時実行は最小の 2 なので、1 並列あたり maxSendRate / 2 通/秒にする（少し余裕を持たせる）
    const SENDER_CONCURRENCY = 2;
    const intervalMs = Math.ceil((1000 * SENDER_CONCURRENCY) / Math.max(cfg.maxSendRate, 0.1) * 1.1);
    const senderFn = fn("Sender", "sender", {
      environment: { ...env, SEND_INTERVAL_MS: String(intervalMs) },
      // 10 通 × 間隔 が収まる長さ
      timeout: cdk.Duration.seconds(Math.min(900, Math.ceil((intervalMs * 10) / 1000) + 30)),
    });
    const sesEventsFn = fn("SesEventsHandler", "sesEvents");
    const nightlyFn = fn("Nightly", "nightly", {
      timeout: cdk.Duration.minutes(15),
      memorySize: 1024,
      environment: { ...env, BACKUP_BUCKET: backups.bucketName },
    });
    backups.grantPut(nightlyFn);

    // 送信権限：送信ドメインの ID と設定セットだけ（アクセスキーは使わず、Lambda のロールに付ける）
    for (const f of [apiFn, senderFn]) {
      f.addToRolePolicy(
        new iam.PolicyStatement({
          actions: ["ses:SendEmail", "ses:SendRawEmail"],
          resources: [
            identityArn,
            this.formatArn({ service: "ses", resource: "configuration-set", resourceName: configSet.configurationSetName }),
          ],
        }),
      );
    }
    queue.grantSendMessages(apiFn);
    queue.grantSendMessages(schedulerFn);
    files.grantRead(apiFn);

    senderFn.addEventSource(
      new SqsEventSource(queue, { batchSize: 10, reportBatchItemFailures: true, maxConcurrency: SENDER_CONCURRENCY }),
    );
    sesTopic.addSubscription(new subs.LambdaSubscription(sesEventsFn));

    new events.Rule(this, "EveryMinute", {
      schedule: events.Schedule.rate(cdk.Duration.minutes(1)),
      targets: [new targets.LambdaFunction(schedulerFn)],
    });
    // 毎日 3:00（日本時間）＝ 18:00 UTC
    new events.Rule(this, "Nightly3amJst", {
      schedule: events.Schedule.cron({ minute: "0", hour: "18" }),
      targets: [new targets.LambdaFunction(nightlyFn)],
    });

    // ---- 公開 HTTP ----
    let domainName: apigw.DomainName | undefined;
    if (cfg.publicHost) {
      // DNS 検証用の CNAME を手動で登録するまで、デプロイはこの証明書の発行待ちで止まる
      const cert = new acm.Certificate(this, "PublicCert", {
        domainName: cfg.publicHost,
        validation: acm.CertificateValidation.fromDns(),
      });
      domainName = new apigw.DomainName(this, "PublicDomain", { domainName: cfg.publicHost, certificate: cert });
    }
    const http = new apigw.HttpApi(this, "PublicApi", {
      defaultIntegration: new HttpLambdaIntegration("ApiIntegration", apiFn),
      ...(domainName ? { defaultDomainMapping: { domainName } } : {}),
    });
    // 公開ページへのリクエスト数を制限する（フォームの連打・総当たりへの対策）
    const stage = http.defaultStage?.node.defaultChild as apigw.CfnStage | undefined;
    if (stage) stage.defaultRouteSettings = { throttlingRateLimit: 20, throttlingBurstLimit: 40 };
    const publicBaseUrl = publicBaseUrlPlaceholder || http.apiEndpoint;
    for (const f of [apiFn, schedulerFn, senderFn, sesEventsFn, nightlyFn]) f.addEnvironment("PUBLIC_BASE_URL", publicBaseUrl);

    // ---- 監視（通知先メールはデプロイ時の環境変数で渡す） ----
    if (cfg.alertEmail) {
      const alerts = new sns.Topic(this, "Alerts");
      alerts.addSubscription(new subs.EmailSubscription(cfg.alertEmail));
      const action = new cwActions.SnsAction(alerts);
      const alarm = (id: string, metric: cloudwatch.IMetric, threshold: number, desc: string) => {
        const a = new cloudwatch.Alarm(this, id, {
          metric,
          threshold,
          evaluationPeriods: 1,
          comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
          treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
          alarmDescription: desc,
        });
        a.addAlarmAction(action);
      };
      alarm("DlqNotEmpty", dlq.metricApproximateNumberOfMessagesVisible(), 1, "送信に5回失敗したメールがあります");
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
      for (const [id, f] of [["Api", apiFn], ["Scheduler", schedulerFn], ["Sender", senderFn], ["SesEvents", sesEventsFn], ["Nightly", nightlyFn]] as const) {
        alarm(`${id}Errors`, f.metricErrors({ period: cdk.Duration.minutes(15) }), 3, `${id} 関数でエラーが続いています`);
      }
    }

    // ---- DNS 登録に必要な値 ----
    if (identity) {
      identity.dkimRecords.forEach((r, i) => {
        new cdk.CfnOutput(this, `DkimCname${i + 1}`, { value: `${r.name} CNAME ${r.value}` });
      });
      new cdk.CfnOutput(this, "MailFromMx", { value: `${mailFromDomain} MX 10 feedback-smtp.${this.region}.amazonses.com` });
      new cdk.CfnOutput(this, "MailFromSpf", { value: `${mailFromDomain} TXT "v=spf1 include:amazonses.com ~all"` });
    }
    new cdk.CfnOutput(this, "ConfigurationSet", { value: configSet.configurationSetName });
    new cdk.CfnOutput(this, "SendIntervalMs", { value: String(intervalMs) });
    if (domainName) {
      new cdk.CfnOutput(this, "PublicHostCname", { value: `${cfg.publicHost} CNAME ${domainName.regionalDomainName}` });
    }
    new cdk.CfnOutput(this, "PublicBaseUrl", { value: publicBaseUrl });
    new cdk.CfnOutput(this, "FilesBucket", { value: files.bucketName });
    new cdk.CfnOutput(this, "BackupsBucket", { value: backups.bucketName });
  }
}

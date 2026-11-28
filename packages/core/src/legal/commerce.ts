/**
 * 特定商取引法に基づく表記（通信販売）のページの中身。
 * 管理画面の設定から自動で作る（/legal/commerce）。項目の名前は一般的な表記にそろえているが、
 * 最終的な文言は販売する商品に合わせて事業者が確かめること（法律の助言ではない）。
 */
export interface CommerceDisclosure {
  /** 販売業者（氏名または名称） */
  sellerName?: string;
  /** 運営統括責任者（法人の場合など） */
  representative?: string;
  /** 所在地 */
  address?: string;
  /** 電話番号 */
  phone?: string;
  /** 所在地・電話番号を「請求があれば遅滞なく開示する」と書いて省略する */
  disclosureOnRequest?: boolean;
  /** 問い合わせ先（メールアドレスまたは URL） */
  contact?: string;
  /** 販売価格 */
  price?: string;
  /** 商品代金以外の必要料金 */
  extraFees?: string;
  /** 支払方法 */
  paymentMethods?: string;
  /** 支払時期 */
  paymentTiming?: string;
  /** 商品の引渡時期 */
  deliveryTiming?: string;
  /** 返品・キャンセル（申込みの撤回・契約の解除） */
  returnPolicy?: string;
  /** 申込みの有効期限（ある場合） */
  offerExpiry?: string;
  /** 動作環境（デジタルコンテンツの場合） */
  environment?: string;
  /** そのほかの販売条件（数量の制限、定期購入の条件など） */
  specialTerms?: string;
}

export const DISCLOSE_ON_REQUEST = "請求があった場合には遅滞なく開示いたします。";

/** 表示する項目（ラベルと値）。空の任意項目は出さない */
export function commerceDisclosureRows(d: CommerceDisclosure): [string, string][] {
  const v = (s?: string) => (s ?? "").trim();
  const onReq = d.disclosureOnRequest === true;
  const rows: [string, string, boolean][] = [
    ["販売業者", v(d.sellerName), true],
    ["運営統括責任者", v(d.representative), false],
    ["所在地", onReq && !v(d.address) ? DISCLOSE_ON_REQUEST : v(d.address), true],
    ["電話番号", onReq && !v(d.phone) ? DISCLOSE_ON_REQUEST : v(d.phone), true],
    ["お問い合わせ", v(d.contact), true],
    ["販売価格", v(d.price), true],
    ["商品代金以外の必要料金", v(d.extraFees), true],
    ["お支払い方法", v(d.paymentMethods), true],
    ["お支払い時期", v(d.paymentTiming), true],
    ["商品の引渡時期", v(d.deliveryTiming), true],
    ["返品・キャンセル", v(d.returnPolicy), true],
    ["申込みの有効期限", v(d.offerExpiry), false],
    ["動作環境", v(d.environment), false],
    ["特別な販売条件", v(d.specialTerms), false],
  ];
  return rows.filter(([, value, required]) => required || value).map(([k, value]) => [k, value]);
}

/** 未入力の必須項目（ページを公開する前・商品を売る前の確認に使う） */
export function missingCommerceFields(d: CommerceDisclosure | undefined): string[] {
  return commerceDisclosureRows(d ?? {})
    .filter(([, value]) => !value)
    .map(([k]) => k);
}

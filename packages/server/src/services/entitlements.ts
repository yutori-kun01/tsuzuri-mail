/** 商品のシナリオを、この読者に送ってよいか（受け取る権利があるか） */
export const PRODUCT_ENTITLED_SQL = (contactParam: string, sequenceParam: string) =>
  `EXISTS (SELECT 1 FROM entitlements en JOIN products p ON p.id = en.product_id
            WHERE en.contact_id = ${contactParam} AND en.revoked_at IS NULL AND p.sequence_id = ${sequenceParam})`;

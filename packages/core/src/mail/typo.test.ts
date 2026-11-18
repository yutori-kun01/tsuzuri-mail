import { describe, expect, it } from "vitest";
import { suggestEmailFix } from "./typo.js";

describe("suggestEmailFix", () => {
  it.each([
    ["taro@gmial.com", "taro@gmail.com"],
    ["taro@gmail.con", "taro@gmail.com"],
    ["taro@gmail.co", "taro@gmail.com"],
    ["taro@gmail.jp", "taro@gmail.com"],
    ["taro@gmali.com", "taro@gmail.com"],
    ["hanako@yahoo.jp", "hanako@yahoo.co.jp"],
    ["hanako@yaho.co.jp", "hanako@yahoo.co.jp"],
    ["hanako@yahooo.co.jp", "hanako@yahoo.co.jp"],
    ["a@iclod.com", "a@icloud.com"],
    ["a@icloud.co.jp", "a@icloud.com"],
    ["a@docomo.co.jp", "a@docomo.ne.jp"],
    ["a@ezweb.ne.p", "a@ezweb.ne.jp"],
    ["a@softbank.co.jp", "a@softbank.ne.jp"],
    ["a@outlok.com", "a@outlook.com"],
    ["a@hotmial.com", "a@hotmail.com"],
    ["Taro@GMIAL.COM", "Taro@gmail.com"],
  ])("%s → %s", (input, expected) => {
    expect(suggestEmailFix(input)).toBe(expected);
  });

  it.each(["taro@gmail.com", "a@yahoo.co.jp", "a@mail.com", "a@me.com", "a@mac.com", "a@live.com", "a@example.co.jp", "a@ymail.com", "a@ocn.ne.jp", "not-an-email"])(
    "leaves %s alone",
    (input) => {
      expect(suggestEmailFix(input)).toBeUndefined();
    },
  );
});

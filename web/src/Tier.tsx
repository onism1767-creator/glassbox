import { tierText } from "./words.ts";

/** 真相等级小标签（T0 观测、T1 推导、T2 声明、T3 机器验证），各面板共用。 */
export function Tier({ t }: { t: string }) {
  return <span className={`tier ${t}`} title={tierText(t)}>{tierText(t)}</span>;
}

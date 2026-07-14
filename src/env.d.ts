// `wrangler secret put` で設定するシークレットの型定義。
// wrangler types は .dev.vars がある環境でしか secrets を Env に含めないため、
// CI でも型が通るようにここで宣言をマージする。
interface Env {
  GOOGLE_CLIENT_SECRET: string;
}
